# Evidence-first directive/rebrief recovery — runbook

Owner approval: journal j-1348 (build), corrections j-1345. This runbook
describes the retained standalone retirement primitive and its non-effects.
The GH-286 workflow below is now primary: evidence-first completion or
checkpoint continuation, otherwise an executable generation-fenced Gru
decision. Routine approved recovery no longer requires per-case owner
intervention. Owner-reserved stops, merges, deployment and production
restarts remain unchanged.

## What it is

An interrupted directive is a request whose prompt may have been delivered
and whose worker ceased mid-turn with no correlated terminal receipt
(`job.delivered`). The request stays live (`dispatching`/`admitted`),
fencing the lane's single-writer guard, review arming, digest offers and
phase completion. `settled` would fabricate a delivery; `failed` would
falsely claim no effect. The guarded retirement closes ONLY that request's
control ownership, after the service itself proves (fresh, server-side)
that no producer still owns the lane, and records exactly one audit event:
`silas.directive-retired`.

**It is not:** success, failure-with-no-effect, permission to resume,
authorization to integrate, a merge decision, or a way to erase history.
The underlying work remains unfinished; a later fresh, authorized request
is still required to touch the lane again.

## Supported predicates (server-verified; any unknown/stale/missing evidence refuses)

The route resolves the lane's checkout HEAD synchronously, then the
ledger re-checks durable producer facts and the binding expectations in
one transaction. No await separates the evidence read from the commit;
the caller supplies expectations only:

- **Request/obligation identity**: job id, live state, exact payload hash,
  and the current directive-recovery obligation's generation, plan revision
  and state (each explicit `null` when there is no recovery obligation) must
  still match. A same-generation re-plan is as stale as a new generation.
- **Current approved authority**: `expected_authority_epoch`,
  `expected_work_revision`, and `expected_contract_sha256` must equal the
  service's current control epoch and approved scope at the write boundary.
  The fresh values are exposed by the directive readback as
  `current_authority_epoch`, `current_approved_authority`, and
  `recovery_obligation` (`generation`, `planRevision`, `state`); they are not
  inferred from a prior decision or from the accepted prompt alone.
- **Known custody**: a row from before native producer identity (no
  producer identity or journal), or one whose admission minion has no
  registration on the job, has unknown custody. Retirement and a Gru
  successor refuse it (`live_work`, `original producer custody UNKNOWN:
  …`), the successor before any review is stopped. Waiting never clears
  that; the owner's exit is [abandonment](#owner-abandonment-unknown-custody).
- **Lane identity/head**: exactly one non-swept job lane for the job, and
  its freshly resolved checkout `HEAD` must equal the caller's
  `expected_head` (a registered branch tip is not checkout evidence).
- **No open worker turn**: no agent of the job in `spawning`/`streaming`.
- **No queued producer**: no non-terminal child worker; no pace-gate
  worker turn queued under the job or one of its agent IDs; no pending
  supervisor restart/backoff, classification, recovery admission or
  automatic rate-limit retry (idle/error durable state is not cessation).
- **No unconfirmed restart cleanup**: no generation-bound
  `supervision.restart-cleanup-pending` / `-confirmed` /
  `supervision.restart-rejected` custody debt for the job. A refused
  replacement is quarantined from every registry lookup and its debt
  refuses retirement until the ORIGINAL native owner records a
  generation-bound disposal acknowledgment plus positive cessation proof
  (see [Restart-cleanup custody](#restart-cleanup-custody-events-crash-surviving-producer-proof)).
- **No in-flight admission**: no process-local admission reserved for the
  job (the boundary every producer crosses before its first await), including
  a pending provider-wall route lookup. The supervisor proof port is a
  required server dependency, never an optional empty fallback.
- **No re-brief**: no `pending_rebriefs` marker.
- **No other live directive**: no live request other than the subject.
- **No provider continuation**: no `waiting`/`recovered-pending` provider
  wait or unproven `claimed` continuation. A correlated
  `provider.continuation-completed`, or failed receipt with a closed `turn`
  or acknowledged `authorization` disposal, ends claim ownership. Generic
  spawn/cleanup errors do not prove cessation, even after a new handoff.
  Active runtime admission and supervisor ownership still refuse.
- **No verification producer**: no unsettled verification run.
- **No review/source ownership**: no `pending`/`live` review round.
- **No live lane process**: no `worktree_processes` row in `live` state
  for the job's lanes that are not swept. A swept lane runs nothing, so a
  row it left `live` never fences (#464).
- **No correlated terminal receipt**: a `job.delivered` correlated to the
  request is refused (`terminal_receipt_present`) — normal settlement owns
  it.
- **Admission preservation**: a correlated `silas.directive-sent` is bound
  first through the existing validated transition (the row then reads
  `admitted-without-terminal`); an admission event without a minion
  identity fails closed (`admission_evidence_incomplete`). Already-bound
  admissions are rechecked against the exact sent sequence/request/minion;
  mismatched identity is never carried into a retirement audit.

## Calling it

`POST /api/silas/directives/{request_id}/retire` (bearer-authenticated,
same configured auth boundary as every Silas surface):

```json
{
  "expected_job_id": "dashboard-slim-strip-current-main-20261007",
  "expected_state": "dispatching",
  "expected_payload_hash": "<payload_hash from GET /api/silas/directives/{id}>",
  "expected_head": "2a37ffb26f9b1a90793b608aedb1e222f6ed7ee6",
  "expected_generation": 1,
  "expected_plan_revision": 0,
  "expected_obligation_state": "open",
  "expected_authority_epoch": 74,
  "expected_work_revision": 0,
  "expected_contract_sha256": "<current_approved_authority.contractSha256>",
  "reason": "service restart 00:37:49Z disposed the writer; no terminal receipt exists",
  "by": "silas-ops"
}
```

`expected_state` is the state the caller verified (`dispatching` or
`admitted`). `expected_generation`, `expected_plan_revision` and
`expected_obligation_state` are JSON `null` together exactly when no recovery
obligation exists; all six freshness fields are required for a live write,
and a missing one is a 400 naming it.
Success returns 200 with `state: "retired"`, `admission_class`, the
preserved admission fields, the hold state, all `retire_expected_*`
expectations, and the closed phase-handoff id (if one was attached). The
exact context is kept in the audit event for restart-safe replay. Replays
with the identical canonical intent return `idempotent: true` and append
nothing; a lost-response retry reconstructs the identical intent from the
retired readback (`retire_expected_state`, `retire_expected_head`, the six
`retire_expected_*` context fields, plus the exposed job/payload hash) or
from the `POST /api/silas/directive` replay of the id (it carries
`payload_hash`, also on a terminal lane), and a replay of a phase-closing
retirement reports the same `phase_handoff_closed` id. A row retired before
the context existed reads all six as `null` ("not recorded") and replays
its original intent with them `null` or absent; any other body against a
retired row is a `retire_conflict`. Retirement resolves the request's
`silas.directive-unreconciled` card (an open recovery debt still reaches
Gru through the obligation mailbox; a suspended one keeps its card).

### Refusals (all leave the record byte-identical)

| HTTP | error | Meaning / next step |
|---|---|---|
| 400 | `bad_request` | malformed body/field or a missing expectation (named); fix and resend |
| 401 | — | missing/wrong bearer token |
| 404 | `not_found` | unknown request id |
| 409 | `directive_not_live` | already settled/failed; use normal flows |
| 409 | `request_mismatch` | wrong job/state/payload hash; re-read the row |
| 409 | `stale_head` | lane head moved; re-verify cessation at the new head |
| 409 | `stale_generation` | recovery obligation generation, plan or state changed; re-read the exact obligation |
| 409 | `stale_authority` | control epoch or current approved work inputs changed; re-read authority |
| 409 | `terminal_receipt_present` | correlated delivery exists; let settlement/reconcile own it |
| 409 | `admission_evidence_incomplete` | admission event without identity; reconcile the actual turn |
| 409 | `lane_unavailable` | unreadable registry / no single live lane / unresolvable head; fail closed |
| 409 | `live_work` | blockers list names the live ownership or the unknown custody; resolve it first (unknown custody: the owner may abandon) |
| 409 | `retire_conflict` | already retired under a different intent; the recorded outcome stands |

## How a candidate surfaces

A retirement is never automatic; the operator side sees a candidate
through existing surfaces:

- the boot reconciler's action-required escalation for a live request
  with no terminal receipt (`reconcilePendingDirectives`, card kind
  `silas.directive-unreconciled.<request_id>`) — the same card the
  observed incident raised;
- the board's next action naming the live directive
  (`directive <id>: <state> (<job>)`), and the authenticated readback
  `GET /api/silas/directives/{request_id}`;
- the Silas digest, which suppresses offers while the request is live;
- for a live request on a terminal job (merged, or binned/done before
  those writes refused live directives), the same card, unbound, naming
  retirement and abandonment.

## After retirement: the continuation hold

Retirement leaves a durable continuation hold on the request row
(`hold_released_by` null). While open, it is a **runtime** fence — not an
attention card:

- branch-idle refuses review arm/freeze on the lane (`409 branch_busy`),
  including forced review and a foreign target ref;
- the Silas digest offers no review/directive/stall, verification-repair,
  minion-error continuation or provider-recovery rows for the job;
- late provider recovery cannot claim/resume the lane or release the hold;
- the board's next action names the retirement.

The hold is released **only** by a fresh accepted directive request or
re-brief marker (the release record names that request/marker id). The
retired request id itself never re-runs and never releases the hold. The
fresh producer owns its own turn: `silas.directive-recovery-handoff`
records the accepted identity and retired request IDs in that transaction.
Exact native event ordering—not clock age—identifies older provider waits.
Unclaimed superseded waits stay recorded and are neither offered nor
resumed, even when the fresh request later settles; proven stale debt
cannot permanently block a later retirement. Claimed producers still need
actual terminal proof. Missing ordered proof stays fenced. A late wait is
left byte-identical while a live hold is open, including on a parked or
blocked job. Sensor probes and boot wakes ignore held/superseded debt;
only its obsolete batch marker closes. Terminal-job wait cancellation is
passive cleanup, never a hold release or work revival. Observation admission
covers credential lookup before wait recording. Fresh directive/re-brief
acceptance refuses while that provider reservation or an unproven claimed
continuation owns the job; a later handoff cannot overtake its pending
lookup or prompt. A breaker ACK is an attention record, not fresh job
authority: supervisor restart and delivery preserve the interrupted turn's
native recovery epoch and refuse held or superseded snapshots, even after
a different fresh request releases the hold. A genuinely fresh interrupted
turn retains its own recovery path. Digest publication rechecks
live ownership and the captured job event watermark after all awaits;
fully settled new authority also retracts a stale offer.
A damaged hold is reported as inconsistent audit debt without hiding
healthy holds on other jobs; strict control callers still fail closed.
A hold on a job that later goes terminal is inert (terminal lanes accept no
work): it is not projected as board debt and cannot mask a newer live
hold.

## Restart-cleanup custody events (crash-surviving producer proof)

A supervisor restart/replacement that is refused (superseded, unreadable
captured authority, terminal job, open retirement hold, failed binding) is
**quarantined** — revoked from every registry lookup synchronously, before
the asynchronous disposal — and its physical disposal is tracked by durable
ledger events, so a crash mid-cleanup cannot hide a live producer from
retirement:

- `supervision.restart-cleanup-pending` — payload
  `{generation, replacement_agent_id}`, written *before* the disposal
  begins. `generation` is the exact **physical-handle** token, minted
  before the write is attempted so a failed write keeps the same binding.
- `supervision.restart-cleanup-confirmed` — payload `{generation,
  origin_seq, replacement_agent_id, disposal_acknowledged,
  cessation}`, written ONLY by the original native owner once disposal is
  fulfilled AND the adapter-owned cessation probe returns `ceased`.
  `disposal_acknowledged` must be `true` and `cessation` must be `ceased`,
  and the confirmation is otherwise bound to the exact originating
  `origin_seq` + `generation`: a mismatched job, agent, generation or
  binding never clears debt.
- `supervision.restart-rejected` — the refusal audit. Its `disposition` is
  `disposed` (custody settled), `cleanup-unconfirmed` (a durable pending
  entry exists but no receipt yet), or `cleanup-unjournaled` (the pending
  write itself failed; the audit carries the SAME pre-minted `generation`).

While any such debt is unconfirmed the job is a live owner: guarded
retirement refuses with `409 live_work` naming the blocker. The blocker is
**generation-bound, not id-bound**: a successor reusing the same logical
minion id mints its own generation, so its clean disposal never releases the
predecessor's custody. Only a receipt carrying the SAME exact generation
(the original custodian's recovered retry) clears it; a legacy audit without
a generation is never id-clearable.

- **No ACK escape**: acknowledging the needs-owner notice
  (`supervision.restart-cleanup-unconfirmed`) is presentation-only; it
  writes no receipt and releases no custody.
- **No restart escape**: a service restart (or a fresh restart rung) cannot
  confirm a generation it did not dispose; the durable events replay the
  debt and re-fence retirement.
- **No successor-cleanup escape**: a same-id successor's clean disposal is
  not proof of the predecessor's cessation.
- **Hard-crash limitation**: if the original native owner is lost before it
  records `disposal_acknowledged` + `cessation: 'ceased'`, the proof is
  genuinely unavailable and the debt blocks indefinitely. That is the
  intended fail-closed behavior — retiring past a possibly-live hidden
  producer is exactly the state #280 closes.

## Proof identity to cite

- request id + accepted payload hash + expected/resolved lane head + fresh
  recovery/current authority context (the event payload carries
  `expected_head`, the six `expected_*` context fields, `lane_id`,
  `admission_class`, `admission_seq`, `admission_minion`, `by`, `reason`);
- event `silas.directive-retired` (exactly one per request);
- a later accepted `silas.directive-recovery-handoff` when citing fresh
  authority (never a delivery/retirement receipt);
- the row's `retired_at`/`retired_by`/`retire_reason`;
- the phase-handoff `closed` reason when one was attached.

## Explicit non-effects

Retirement never spawns/resumes a worker, never arms review, never
advances publication, never completes a phase, never clears owner stops
or decisions, never authorizes integration, never merges/deploys, and
never rewrites a terminal receipt or a late event. It does not modify
job status, obligations, approvals, reports, verification outcomes or
other jobs.

### Binning an abandoned lane

A deliberate job discard is a separate operation from directive retirement.
Use the existing authenticated `POST /api/jobs/<id>/status` surface with
`{"status":"binned"}` only after every live directive request has settled,
been retired through this cessation-fenced path, or been abandoned by the
owner, and every pending re-brief marker likewise. The status transaction
refuses each one by name; a caller cannot make an unknown native request
disappear by binning its job. `done` and closeout refuse them the same way.
`merged` is an observed fact and is recorded; the reconcilers keep
processing a live request on it, and a merge never retires a marker whose
producer custody is unproven (it stays on a card instead). Other live-work
blockers remain in force.

Binning records only the terminal administrative discard. It does not
prove cessation, no effects, completion, delivery, onboarding, or READY,
and does not clean retained resources.

### Owner abandonment (unknown custody)

When the service cannot establish a live request's producer custody (no
producer identity or journal, a minion with no registration on the job, no
or several lanes, unproven cleanup), retirement stays refused. The exit is
the owner's decision, never Gru's: Gru asks the owner and never calls it.

```json
POST /api/silas/directives/{request_id}/abandon
{
  "expected_job_id": "<job_id>",
  "expected_state": "admitted",
  "expected_payload_hash": "<payload_hash>",
  "reason": "original producer identity and journal are missing",
  "by": "owner",
  "confirm_intent": true
}
```

Without `by: "owner"` and `confirm_intent: true` it is a 400. It refuses
(409 `live_work`, by name) any producer known to be live or about to run: a
lane process, a provider continuation, a native session lock, a re-brief or
another request owning the lane, an open turn, an admission, a child, a
review round, a verification run, a queued turn, or a supervised restart,
retry or open turn (or a supervisor it cannot read). Only producer-custody
uncertainty may be abandoned. It also refuses a request settlement owns
(`terminal_receipt_present`), a stale view (`request_mismatch`), a request
that is not live (`directive_not_live`), and one whose cessation the service
can verify (`retirement_available`: retire it instead).

It records the request `failed` with `fail_reason` "abandoned by the owner;
outcome and producer custody unknown: …" and appends one
`silas.directive-abandoned` event whose `unknown` and `retirement_refused`
name what stays unknown and why retirement was refused. It closes the
request's own recovery debt and its card as outcome-unknown, and leaves an
open continuation hold: automation stays off the lane, and only binning or
a fresh request the owner accepts (`by: "owner"`, `confirm_intent: true` on
`POST /api/silas/directive` or `/api/silas/rebrief`) releases it. It claims
no completion, no effect and no cessation, and clears no
producer-uncertainty record. Every reader reports the request `abandoned`,
never as a no-effect failure. A replay rebuilt from GET (`expected_state:
"abandoned"`) returns the recorded abandonment (`idempotent: true`).

A pending re-brief marker generation of unknown custody has the same exit:
`POST /api/silas/rebriefs/{marker_id}/abandon` with `expected_job_id`,
`expected_payload_hash`, `reason`, `by: "owner"` and `confirm_intent: true`.
It deletes the generation's markers with one `silas.rebrief-abandoned`
audit, under the same refusals, hold and closures.

One state has no exit: a job carrying both a live directive and pending
re-brief markers (legacy history only; the single-writer rule refuses it
now). Each abandonment sees the other control as live and refuses: it is
an owner-escalation dead end that no route here closes; the owner must bin
the job.

### The shared bearer and owner-only fields

The HTTP bearer token is shared: Gru and the owner authenticate with the
same secret, so a `by: "owner"` field is the only barrier between an
automation decision and an owner decision. Every refusal that names an
owner-only exit therefore says *ask the owner*, never the request body that
would take it; `roles/gru.md` forbids Gru from reconstructing one from a
refusal's wording or from the examples below. For the same reason an owner
acceptance of a fresh request refuses while the abandoned control's
original producer cleanup is still unproven: releasing the hold there would
strand a `dispatching` request whose own claim refuses on unproven
cessation, so binning — the one exit that needs no cessation — stays the
answer until the cleanup blockers clear.

## Activation rules

- Routine live approved recovery uses the guarded Gru decision described
  below; owner-reserved destructive actions still require an owner ruling.
  There is no bulk mode, `force` option or age-based work authority.
  Historical terminal administrative retirement remains non-executing.
- The activation this build ships is CODE + MIGRATION only: the schema
  migration applies at the next service boot under the owner's manual
  rollout. This build performed no live retirement, no migration against
  the production ledger and no service restart.
- A retired request cannot revive a merged/done/binned job, and it is
  excluded from boot/tick reconciliation and digest offers by state.

## Evidence-first progress recovery (GH-286)

New directive **and rebrief** acceptance uses `pending_directives`, with
`request_kind`, accepted contract/revision and authority epoch. Rebriefs
no longer create new legacy marker pairs. Accepted is not admitted: the
Pi adapter durably associates the exact request/hash/logical minion/native
session and native user entry before calling the admission observer.
Queued prompts retain these options but produce no admission receipt. A positively observed routing-guard refusal before any native operation records `silas.directive-dispatch-deferred` against the exact dispatch reservation. Bounded reconsideration can retry only that unconsumed original request under unchanged current authority after its fences settle. Missing targets/receipts, expired claims, attempted spawns or uncertain cleanup never supply this proof.
Spawn/init/turn-start cannot establish acceptance. The native association
journal is `<session.jsonl>.directives.jsonl`; native receipt identity and
its role/cwd/tool/model authority manifest are validated on readback.
Unknown/malformed/partial evidence is never repaired by guesswork.

Readback is bounded by the directive's own turn, never by the session's age
(#469), so a long-lived minion still takes directives, revision
continuations and `/recover` successors.

- **Header.** It is the first line alone, at most 64 KiB, on every path.
- **Before the baseline.** The transcript is streamed past, never held
  whole. pi keeps only the entry ids up to the baseline entry and checks
  them for uniqueness; each pi entry there is bounded at 32 MiB. Claude
  Code re-hashes the exact byte prefix.
- **The turn.** The turn after the baseline is read only as far as the
  inspection walks:
  - admission stops at its receipt;
  - a checkpoint stops at its result, or at its terminal plus the next
    bound request;
  - a tool fence reads the live turn.

  Only the turn's own lines count against 32 MiB and 250,000 entries, so a
  session's later growth never pushes an earlier directive past its limits.
  A pi checkpoint's lookahead past its terminal (the next request and its
  model/thinking controls) has its own 32 MiB / 250,000-entry bound and is
  refused under its own name, as the lookahead, never as the turn. The
  entry after a receipted retry error row (#483, below) is read as that
  lookahead, and charged back to the turn when it is the SDK's retried
  answer. One too large to read at all is refused as the lookahead before
  its role is known; it is past both bounds.

What is still refused by name, wherever a walk reads it:

- on both runtimes, a directive turn past either limit and invalid UTF-8;
- on pi, a torn entry, a reused or missing entry id, and a missing
  baseline;
- on Claude Code, a changed byte prefix and a line that is no JSON object.
  A torn final line only ends a Claude walk, because the live writer may be
  mid-frame. Frame uuids are not checked for uniqueness.

A pi entry that is not JSON still fails as a JSON parse error, as it did
before #469.

Boot and bounded deterministic reconsideration inspect correlated ledger
completion, then exact native completion, **before** considering execution.
A proven native user checkpoint, or a complete tool-results checkpoint that
leaves no tool error unanswered, can continue once through the
adapter-owned operation on the same logical minion/session, job lane,
branch and PR. The SDK's own "not executed" results for a `length` row's
calls (below) are no such error: nothing ran. The original user prompt is never
replayed. Every producer/permission fence is rechecked around asynchronous
pacing/spawn/continuation boundaries. A durable checkpoint claim cannot be
reissued by age or lease expiry. A turn that ended in its own native error
or abort, unresolved tool results/effects, changed native authority and
unsupported runtimes refuse loudly. Claude Code checkpoints are never
continued (#424): an interrupted Claude directive is Gru's recovery
decision.

A failed tool call is not a native error. It is ordinary work, such as a
failing test or a `grep` with no match. The minion may go on calling tools,
and a turn that reaches its own successful end completes, on both runtimes.
A turn cut off right after a tool error the minion never answered never
completes: it stays UNKNOWN, or reads as a failed turn when pi recorded the
abort. On pi that may be an interrupted effect, except the SDK's own "not
executed" results for a `length` row's calls (below): nothing ran, so a turn
cut off right after them is resumable. On Claude Code, a success result
straight after one means the CLI ended the turn by itself. A lane's
verification policy refusing a test command is ordinary too: the minion is
told why and goes on. A tool the directive refused is never ordinary. That
covers the authority fence's refusal and, on Claude Code, a request the
permission channel denied itself: one that was malformed or foreign, or
whose fence failed. Each leaves a `guard-refused` receipt, and the turn
stays UNKNOWN. On pi every later tool call of that directive is refused too,
and on Claude Code the refusal ends the turn.

A provider error the pi SDK retries is not the turn's end either (#483).
After a retryable error, such as a truncated stream, the SDK keeps the
assistant error row in the transcript and retries from it. When the SDK
emits its live `auto_retry_start`, the adapter writes a `retry-start`
receipt to the producer journal (below), through the directive's own
started physical producer. The receipt names the error row's entry id and
its error message. It is written only from that live event, never from
transcript history, so a retry the adapter never saw has no receipt.

Owner ruling 2026-10-22: an error row's tool calls, partial ones included,
never ran, because the SDK executes no call of an error row. They are inert
retry history when the row is retried, and owe no results when the row
ends the turn. The tool fence, the checkpoint and settlement read an error
row as retry history only when all of these hold:

- a receipt from a producer of this exact directive identity names the row
  and its exact error;
- the row holds only text, thinking and tool calls;
- the SDK's retried answer, an assistant entry parented on the row, follows
  it.

Its calls never enter the pending set, so a result naming one is never a
match, and the turn reads UNKNOWN. After a retried answer that leaves
calls pending, the reason is `unmatched/malformed native tool result`.
After one that ends the turn (an aborted answer holding calls ends it too),
or when the error row itself ended it, the reason is `native entries follow
the correlated terminal checkpoint without a distinct bound request`.

When a retry is cancelled during backoff, no retried answer follows, so the
receipted row is the turn's terminal, a failed one. When attempts run out,
the SDK starts no retry for the last error: the receipted rows before it
are history, and that unreceipted last row is the failed terminal. An error
row that ends the turn is that failed terminal even when it holds tool
calls. Pi's other continuation of an error reply, its compact-and-retry
(#481, [SUPERVISION.md](./SUPERVISION.md)), is read before that terminal:
an error row Pi compacted on and continued is history too. Pi auto-retries
a reply or compacts and retries it, never both, so a receipted row that is
also compacted and retried is refused by name. At the tool fence any other
error row still refuses the next tool, under a reason naming what it lacks:
a matching receipt, history-only content, or the retried answer.

Every pi stop can hold tool calls, and the walks and the fence follow what
the SDK's agent loop does with them:

- `toolUse` and `stop`: the SDK runs them. Providers that report `stop`
  with tool calls (e.g. OpenAI-compatible chat completions) leave a `stop`
  row holding calls, so such a row is pending work, not the turn's end, and
  never a successful turn verdict; one without calls is the terminal.
- `length`: the calls were cut off by the output token limit. The SDK runs
  none and answers each with its own failed "not executed" result, then goes
  on. Those calls are pending until those results arrive, and the minion
  may call tools after them. Since nothing ran, a turn cut off right after
  those results is resumable, not a tool error awaiting a recovery
  judgment. A turn cut off before them stays UNKNOWN. Such a row is never
  compacted and retried; only a length row without calls may be.
- `error` and `aborted`: the SDK runs none (for an error row, the ruling
  above). Such a row owes no results; ending the turn, it is a failed
  terminal, and a result naming one of its calls is refused.
- Any other stop (pi-ai also has `pending` and `deferred`): a row holding
  calls under it is refused, by the checkpoint as `native assistant stop
  reason holding tool calls is unsupported` and by the fence.

When the adapter cannot record a receipt it logs `native SDK retry
evidence not recorded; retry-history tool effects remain refused` at warn,
with the reason or the error, and the directive stays fail-closed. A
malformed `retry-start` receipt, or two that give one row different errors,
makes the journal read refuse loudly. A build from before this change does
not know the `retry-start` state, so rolling back past it makes a journal
that holds one unreadable: inspection of every directive on that session
refuses (fail-closed) until the rollback is undone.

Physical ownership is recorded separately in `<session.jsonl>.producers.jsonl`:
request/hash/revision/epoch, logical minion, native session/file, physical UUID,
host and PID. Dispatch reservation is not native admission or producer start.
The physical receipt is flushed before native execution, and the real Pi tool
hook flushes exact assistant tool intent before a tool can run. Preparation
attests the runtime's own idle/independence state and journals that physical
producer BEFORE any target is retained (issue #453): a refused preparation
therefore leaves no target to fence forever, and a retained target can never
exist without a physical producer record to inspect. A target whose producer
journal is missing, torn or foreign is still UNKNOWN, never a fabricated
never-started receipt. An INTERRUPTED preparation can leave that producer
record with no target and no ledger start: the request stays retirable (no
target, no correlated start). The residue is a journal entry whose evidence
is `host-absent` while its pid is gone — it fences nothing — but a REUSED pid
reads `unknown` and fences later work on that session until a cessation
receipt supersedes it. It is a preparation artifact, not a delivered turn.
The idle attestation is adapter-strength: Pi proves idle plus no independent
bash controller, Claude Code proves idle only (its controller is recorded at
spawn). Native
independent bash controllers leave durable uncertainty until genuine cleanup.
Only exact-incarnation cleanup or an original same-host PID returning ESRCH
can establish original host cessation; a live/frozen/reused PID, foreign host,
EPERM, torn journal or legacy missing incarnation stays UNKNOWN. Host absence
alone does not prove tool/child cessation. Automatic continuation additionally
needs a safe native checkpoint and all independent lane/child/provider/review/
verification fences. Its native lock reclaim names only that absent original
PID; no heartbeat age or missing registry is permission. The ledger closes
only that exact start token, never a later same-logical-minion incarnation.

Verification recovery also preserves original identities. Same-request terminal
replay may reconcile matching registry process rows only after both the exact
PID and its detached process group are absent. It records
`verification.process-reconciled`, preserving failed/SIGTERM outcomes and
partial captures; it never reruns tests or supplies a missing capture EOF.
Live/ambiguous/foreign process rows remain fenced. Scheduler shutdown records
`verification.no-start` for queued/granted attempts that never spawned, with
the original run/request identities. Readback remains `admission-failed`
(`scheduler_disposed`) after restart; same-ID replay settles evidence, not a
new producer. Historical requests without authoritative terminal/no-start
proof remain UNKNOWN; an empty scheduler or a lost log cannot settle them.

Authenticated request readback exposes `native_target`, `native_binding`,
`recovery_checkpoint`, `recovery_decision`, `authority_epoch`,
`current_authority_epoch` and `recovery_obligation` (including generation).
Concrete routine Gru judgment uses
`POST /api/silas/directives/<request_id>/recover`:

```json
{
  "by": "gru",
  "expected_generation": 1,
  "expected_payload_hash": "<accepted hash>",
  "expected_head": "<fresh checkout HEAD>",
  "expected_epoch": 0,
  "expected_work_revision": 0,
  "expected_contract_sha256": "<current approved contract SHA256>",
  "reason": "inspect preserved effects and finish approved scope",
  "decision": {
    "kind": "successor",
    "request_id": "<explicit fresh unused ID>",
    "directive": "<concrete approved follow-through>"
  }
}
```

The service proves cessation and atomically retires only that exact
request and accepts the named fresh successor. Retirement itself grants
no authority. The old recovery debt settles on **actual successor native
admission**, or its correlated completion, never mere acceptance. An
identical decision replay appends nothing and starts no second turn;
changed generation/hash/head/epoch, live/queued/unproven producers,
terminal/held/superseded work and owner stops refuse (409). A concrete
reserved-owner decision instead names a real still-open owner obligation
using `decision: {"kind":"owner-decision","obligation_id":"..."}`; it
settles Gru's recovery judgment only, preserving the owner stop and its
debt. Generic Ops holds or notification prose cannot cover recovery debt.
The existing bearer boundary authenticates the call; `by` remains audit
attribution, not cryptographic role identity.

### Fresh-session successor (#470)

A `successor` is a directive, and every directive resumes the worker's
existing session. When that session cannot be resumed (for example a
directive turn in it is refused by name, or the runtime keeps failing to
admit on it), name a **fresh-session** successor instead:

```json
"decision": {
  "kind": "rebrief-successor",
  "request_id": "<explicit fresh unused ID>",
  "note": "<concrete approved follow-through>"
}
```

The rest of the body is the same as for `successor`, including the
current `expected_work_revision` and `expected_contract_sha256`. It takes
the same fences in the same transaction: generation, payload hash, HEAD,
epoch, current revision and contract, owner stops, and proven producer
cessation (a live, queued or unproven producer refuses with 409). The
stuck request is retired and the successor is accepted as a **rebrief**,
the one request kind dispatched with a fresh session. It runs on the same
job lane, branch and PR, and any resident session is disposed first. The
debt settles on the successor's actual native admission, never on
acceptance. An identical replay appends nothing and starts no second
worker. Only `/api/silas/directives/{id}/recover` accepts this kind; a
legacy marker's `/recover` refuses it with 400.

### Settling an orphaned retired request (#470)

A request retired outside `/recover` (for example by the standalone
`/retire`) keeps its open recovery debt: retirement grants no authority
and settles nothing. If a separate request that carries its approved
work was later admitted, Gru settles that debt with an explicit,
non-executing judgment that names the later request:

```json
{
  "by": "gru",
  "expected_generation": 1,
  "expected_payload_hash": "<the retired request's accepted hash>",
  "expected_head": "<fresh checkout HEAD>",
  "expected_epoch": 0,
  "reason": "approved work completed by the later fresh-session rebrief",
  "decision": { "kind": "reconcile-admitted", "admitted_request_id": "<later admitted request>" }
}
```

The ledger checks, in one transaction, that:

- the generation, payload hash, HEAD and epoch are current;
- the subject request is `retired` (a live request takes a successor
  decision instead) and its debt is open or waiting and unclaimed;
- the lane the retirement bound is still the job's single live lane;
- the named request is a different request of the same job with an
  actual native admission (its correlated `silas.directive-sent`), and
  that admission comes **after** the retirement;
- its work revision is the same as or higher than the retired request's.

A live request, a request that was only accepted, an admission that
predates the retirement, a lower or unknown revision, a request of
another job and a claimed debt are each refused with 409; nothing
changes. A legacy marker's `/recover` refuses this kind with 400.

The settlement proves admission, not completion: the later request may
still be running or may end without delivery. Lane identity is the
job's lane id, which is the job id, so "same lane" means the job's one
live lane still exists under the id the retirement bound. Native
admission itself requires the job's single live lane at that moment, its
registered branch and a session started in its checkout; a lane swept and
re-created under the same id between the two would not be told apart.
A pre-revision (legacy) request has no known revision and cannot be
reconciled; that refusal is deliberate.

On success, `silas.directive-recovery-decided` records the decision and
an `admission` block (the admitted request, its admission seq, minion,
revision, the retired revision, the retirement seq and the lane). The
debt settles as `executed-action`, citing that admission's
`silas.directive-sent` event, and the action-required card resolves. No
worker starts and no work revision or current authority is required. An
identical replay returns `idempotent: true` and appends nothing. There
is no age policy: an orphan settles only through this explicit call.

The retired request takes no new successor. Gru first checks the job for
a later request that already carries the work, live or admitted, and uses
it; only when there is none does Gru start one itself (`POST
/api/silas/directive` or `/api/silas/rebrief`). It reconciles once that
request is admitted.

A request retired **by** a `successor` or `rebrief-successor` decision
has already used its debt's generation on that decision. If the named
successor then ends without native admission (a positive no-effect
failure, or its own retirement), it can never settle the debt. In the
same transaction the ledger records `silas.directive-recovery-reopened`,
closes that debt as `superseded` and opens the next incarnation with a
fresh generation (still suspended if the old one was, or while the job
is parked). The new incarnation's next action tells Gru to look first
for a later request already carrying the work (live or admitted), begin
one only if there is none, and then use `reconcile-admitted`. An open
reopened debt reaches Gru through the obligation mailbox, so the old
action-required card, which names the consumed generation, is resolved;
a suspended one keeps its card as the pointer. The old
generation stays consumed: replaying any other decision for it is
refused as a conflict. A chain is handled link by link: when Gru
recovers a stuck successor B with C, retiring B reopens A's debt, C's
admission settles B's debt directly, and Gru reconciles A against C.
At boot the service reopens, once, any debt left stranded this way by a
build that predates this behaviour (`reopenStrandedRecoveryDebts`). Each
successor repairs in its own transaction; one that refuses is logged by
name and never blocks the others or the service start.

Historical `pending_rebriefs` retain their original markers and audit.
Their old blind replay/fresh-session boot pipeline is removed. Spent
correlated evidence can settle, and terminal administrative retirement
remains non-executing. Unprovable live markers instead expose concrete
Gru debt through `GET /api/silas/rebriefs/<marker_id>` and its `/recover`
route with the same fences. Guarded retirement records the exact marker
pair in audit and accepts a fresh directive successor in one transaction;
no bulk delete or age policy exists.

This replaces the old per-case owner-intervention requirement for
**routine approved recovery judgment** only. Owner-reserved destructive
steps, every merge, deployment and production service restart remain
unchanged. Implementation/verification uses isolated fixtures only: no
live migration, recovery, deployment, restart or remote operation is
performed by this build.


Successor decisions additionally require **separate current-authority**
`expected_work_revision` and `expected_contract_sha256` expectations,
read from `current_approved_authority`. These are not the predecessor's
accepted revision/hash. Owner amendment acceptance advances the control
epoch and refuses old queued/in-flight continuation. An exact old request
may nevertheless be retired with a distinctly named fresh successor on
its still-approved live lane when **only approved amendments** account
for its epoch mismatch, producer cessation is proven, and the new current
revision/contract/HEAD/epoch all match atomically. Owner stops, holds,
terminal/superseded dispositions and any other/unprovable control change
cannot use this amendment-only exception. Execution rechecks the fresh
snapshot around awaits; its prompt contains the current effective
contract. Original native admission/delivery revisions are never rewritten.

## Exact historical receipts and partial completion

Historical observation uses bounded whole-job row-cursor pages at boot and on ticks. Neither wall-clock age nor a newer same-job event is correlation. Cancellation does not consume an unobserved page; unresolved early groups cannot starve independent later completion.

Authenticated legacy GET `/api/silas/rebriefs/{marker_id}` exposes versioned `receipt_evidence` and `receipt_evidence_sha256`. The canonical SHA256 covers the exact stored generation, immutable original phase facts and relevant accepted/unproven receipt candidates. Explicit other jobs/generations do not perturb it. A legacy `/recover` judgment **requires** `expected_receipt_evidence_sha256`; the ledger recomputes it inside the write transaction. The hash fences stale intent only: it grants no permission and proves neither cessation nor effects. Native `/recover` bodies take no receipt evidence hash.

An unmarked historical receipt needs explicit exact marker identity/hash, original bound minion and revision. A marked receipt needs a phase independently belonging to the exact original generation and consistent original minion facts. Missing duplicated revision on old marked `silas.rebrief` receipts remains absent; all available original marker/receipt revisions must agree. Reused/rebound/foreign phases, conflicting minions/revisions and same-job late unrelated events are not proof.

A lone exact delivery is immutable **partial** evidence. Gru may explicitly judge a separately named fresh remaining-work successor after actual cessation, current permission and all producer fences; the old missing completion is never manufactured. Genuine original completion always wins over original-work successor judgment. A lost delivery is reconstructible only from explicit original correlated HEAD/revision facts, with their source event recorded. Today's branch HEAD/current approval and `?? 0` cannot supply history.

For exact proven completion lacking original delivery facts, legacy-only `/recover` accepts:

```json
{
  "by": "gru",
  "expected_generation": 1,
  "expected_payload_hash": "<readback>",
  "expected_receipt_evidence_sha256": "<fresh readback>",
  "expected_head": "<current original-lane checkout HEAD>",
  "expected_epoch": 0,
  "expected_work_revision": 0,
  "expected_contract_sha256": "<current approved contract>",
  "reason": "exact completion proven; missing historical delivery facts remain absent",
  "decision": { "kind": "reconcile-completed", "inspection_request_id": "distinct-current-inspection" }
}
```

This is a **non-executing old control closure**, not historical delivery or READY. It requires exact completion, fresh evidence/current scope/HEAD and actual producer/ownership fences; a reconcilable complete generation belongs to normal settlement instead. The immutable `silas.rebrief-control-closed` audit retains full markers, original receipt provenance, absent facts and exact current-inspection instruction. The old debt closes administratively into a discoverable Gru-owned `rebrief-current-inspection:{marker}` obligation. It is suspended when real owner stops/parking govern. No minion spawns and no `job.delivered` is emitted by this judgment.

GET retains decision events and `current_inspection_obligations` after marker closure. Gru separately uses existing `/api/silas/directive` with the named unused inspection request and **exact current-inspection instruction**, then existing verification/review APIs. Its receipts are explicitly CURRENT evidence; they never replace the absent historical delivery or authorize READY. A changed/foreign instruction cannot consume the reserved inspection identity.

## Reserved-owner transfer and explicit owner actions

A routine recovery uncertainty owes Gru a concrete executable decision. Only a **real live same-job, job-wide `operation` / known `owner-hold` / `owner-decision`** may receive a reserved-owner transfer. Generic/unknown/Gru/foreign/limited decisions do not qualify. Suspended or incoherent legacy subjects may transfer their exact unknown context; this never authorizes a successor or synthesizes coherence. A suspended Gru debt closes via the existing superseded/closed transition, not an illegal suspended→settled transition. Requests, markers, producer ownership, real owner debt/stops and owner notification Ack remain unchanged.

Readback `recovery_owner` exposes immutable per-subject/per-debt-generation decision history, the exact transfer target ID/generation/plan/authority/category/action, full evidence snapshot, current target, resolution/confirmation receipts, stop-lineage SHA and an explicit owner-action recipe. Consumed original-generation replay stays immutable after later decisions. Changed or generically closed targets create one new **suspended** Gru incarnation, never revive the old prompt or grant work. A genuine explicit resolution permits a separate current-fenced new incarnation only after separate job unpark; existing producer/review/verification/other owner-stop fences still apply.

Permission recording is an explicitly attributed authenticated call, never invoked by Gru/service/supervisor:

`POST /api/silas/{directives|rebriefs}/{id}/owner-resolution`

```json
{
  "by": "owner", "confirm_intent": true,
  "resolution_id": "stable-owner-resolution-identity",
  "expected_transfer_event_seq": 123,
  "expected_transfer_fingerprint": "<readback>",
  "expected_subject_sha256": "<readback>",
  "expected_target_generation": 2,
  "expected_target_plan_revision": 1,
  "expected_lineage_sha256": "<fresh readback>",
  "expected_epoch": 120,
  "expected_head": "<current original-lane checkout HEAD>",
  "expected_work_revision": 1,
  "expected_contract_sha256": "<current approved contract>",
  "reason": "explicit narrow permission for this exact subject/current scope/governing stop"
}
```

The server constructs an immutable narrow `ruling.recorded` permission and validates exact subject/transfer/target/lineage/current scope. It does **not** release a stop, unpark, Ack, execute work or assert cessation/effects/completion. Shared bearer authentication plus `by: owner` is attribution, **not independently verified owner identity**.

A separate explicitly owner-attributed `POST .../owner-resolution/confirm-stop` uses fresh expectations plus `expected_resolution_fingerprint` from the real recorded ruling. It affirms the exact still-current target/ruling and atomically settles **only that governing open, waiting or suspended target** with a genuine confirmation receipt. A suspended target alone requires the legal resume-before-settle transition; an open or waiting target requires no artificial suspension. Parking, other holds, cards and work execution remain unchanged. Stable identity replay returns immutable original receipts; conflicting intent refuses. Missing/foreign/stale resolution, plan/scope/epoch changes and unrelated stop lineage do not grant permission.

Then, only if intended, explicitly unpark via the existing board action and explicitly Ack any real owner notification separately. A fresh Gru recovery generation/judgment—not the owner recording/confirmation—may accept a distinct currently authorized successor after actual cessation. No automatic owner action, role substitution, original-work replay, additional scope or READY claim is permitted.
