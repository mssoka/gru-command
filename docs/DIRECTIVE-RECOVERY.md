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
  "reason": "service restart 00:37:49Z disposed the writer; no terminal receipt exists",
  "by": "silas-ops"
}
```

`expected_state` is the state the caller verified (`dispatching` or
`admitted`). Success returns 200 with `state: "retired"`,
`admission_class`, the preserved admission fields, the hold state, the
recorded `retire_expected_state`/`retire_expected_head`, and the closed
phase-handoff id (if one was attached). Replays with the identical
canonical intent return `idempotent: true` and append nothing; a
lost-response retry reconstructs the identical intent from the readback
(`retire_expected_state`, `retire_expected_head`, plus the already
exposed job/payload hash), and a replay of a phase-closing retirement
reports the same `phase_handoff_closed` id.

### Refusals (all leave the record byte-identical)

| HTTP | error | Meaning / next step |
|---|---|---|
| 400 | `bad_request` | malformed body/field; fix and resend |
| 401 | — | missing/wrong bearer token |
| 404 | `not_found` | unknown request id |
| 409 | `directive_not_live` | already settled/failed; use normal flows |
| 409 | `request_mismatch` | wrong job/state/payload hash; re-read the row |
| 409 | `stale_head` | lane head moved; re-verify cessation at the new head |
| 409 | `terminal_receipt_present` | correlated delivery exists; let settlement/reconcile own it |
| 409 | `admission_evidence_incomplete` | admission event without identity; reconcile the actual turn |
| 409 | `lane_unavailable` | unreadable registry / no single live lane / unresolvable head; fail closed |
| 409 | `live_work` | blockers list names the live ownership; resolve it first |
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
- the Silas digest, which suppresses offers while the request is live.

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

- request id + accepted payload hash + expected/resolved lane head (the
  event payload carries `expected_head`, `lane_id`, `admission_class`,
  `admission_seq`, `admission_minion`, `by`, `reason`);
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

Boot and bounded deterministic reconsideration inspect correlated ledger
completion, then exact native completion, **before** considering execution.
A proven native user or complete successful tool-results checkpoint can
continue once through the adapter-owned operation on the same logical
minion/session, job lane, branch and PR. The original user prompt is never
replayed. Every producer/permission fence is rechecked around asynchronous
pacing/spawn/continuation boundaries. A durable checkpoint claim cannot be
reissued by age or lease expiry. Native errors/aborts, unresolved tool
results/effects, changed native authority and unsupported runtimes refuse
loudly. Claude CLI currently cannot attest this exact checkpoint protocol;
its capability refusal stays visible rather than inventing admission.

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
existing session. When that session cannot be resumed (for example its
transcript is over the inspection limit), name a **fresh-session**
successor instead:

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
live lane still exists and is the lane the retirement bound. Native
admission itself requires that single live lane, its registered branch
and a session started in its checkout, so a later admission ran there.
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

A request retired **by** a `successor` or `rebrief-successor` decision
has already used its debt's generation on that decision. If the named
successor then ends without native admission (a positive no-effect
failure, or its own retirement), it can never settle the debt. In the
same transaction the ledger closes that debt as `superseded` and opens
the next incarnation with a fresh generation. The new incarnation's next
action names `reconcile-admitted`, and Gru settles it as above once a
later request carrying the work is admitted. The old generation stays
consumed: replaying any other decision for it is refused as a conflict.

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
