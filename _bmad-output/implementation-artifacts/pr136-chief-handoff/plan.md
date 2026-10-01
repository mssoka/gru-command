# PR136 chief handoff — code-informed amendment, interfaces and test map

Phase id: `pr136-chief-handoff-20261001`
Job: `durable-blocked-followthrough` — branch `gru/durable-blocked-followthrough`
PR: #136 (open, draft preserved)
Status: plan checkpoint (implementation continues on this worker under the
re-brief mandate; this document is the lane execution record for the delta,
not a claim about the chief's render or any other lane's work).

## 1. Authority and what this delta is

- Re-brief `PR136-CHIEF-HANDOFF-20261001` (owner-approved, ruling `j-501`):
  continue ONLY this job/branch/draft PR; bounded delta on top of the
  existing approved `durable-blocked-followthrough` undertaking.
- Chief scope observation `j-499` + proposed scope:
  `/Users/moses/.gru-command/briefings/chief-decision-handoff-heist-20261001/proposed-scope.md`.
- Historical lane records (read as evidence, preserved unmodified):
  `_bmad-output/implementation-artifacts/spec-durable-blocked-followthrough.md`,
  `/Users/moses/.gru-command/briefings/durable-blocked-followthrough-approved-20260928/plan/`
  (`ready-for-development-spec.md`, `acceptance-tests.md`, `overlap-and-sequencing.md`),
  `_bmad-output/implementation-artifacts/durable-followthrough-rebase-20260930/receipt.md`,
  `_bmad-output/implementation-artifacts/durable-followthrough-ci-repair-20260930/`.
- The chief's `proposed-scope.md` is NOT this lane's execution; this
  document is the code-informed amendment and execution map for the delta.

### Verified refs at plan time (full SHAs)

- Lane base before this session: `0bb5a03f80ac8f65da078420f29e86325214eccb`
  (open draft PR136 head).
- Upstream main fetched: `2aa836abe262759c651683deb40d05f02c9ede86`
  (PR #146, non-draft PR instructions) — merged into this branch by an
  ordinary history-preserving merge, commit
  `5ccae79b1fb0b457c81b5661feb6adf99a4e4665`; merge verified semantically
  (both sides' pins and PR-creation wiring retained).
- No force/rebase/reset/stash; no other checkout touched.

## 2. Gap statement (verified in current source, after the merge)

`src/dispatch/obligations.ts::observeFollowUpDelivery` is the only
attention writer in this area. At the base it:

1. accepts only `job.delivered` with `payload.source` in
   `{silas-directive, silas-rebrief}`;
2. requires `job.status === 'blocked'`;
3. keys the hand-back on the DELIVERY EVENT SEQUENCE
   (`phase-handback@<seq>`) and mints a per-event notification kind.

Consequences (the exact gap the re-brief names):

- a fresh artifact-only dispatch (`source=dispatch`, working→delivered, no
  commit/PR) is excluded — the shutdown-audit incident shape;
- a same-head directive/rebrief completion on a NONblocked lane is excluded;
- identity is the event sequence, not a host-owned phase/request/generation
  identity persisted BEFORE side effects;
- no durable completion-intent exists, so a crash between a phase request
  and its completion has nothing to reconcile for the general case;
- the existing narrower blocked hand-back and directive-request machinery
  (`pending_directives`, `pending_rebriefs`) are already durable and must
  not be replaced.

## 3. Design (smallest additive representation)

### 3.1 Explicit, typed intent captured before side effects

A new optional HTTP field `completion_handoff` on the three phase-authorizing
requests:

```json
{ "kind": "gru-decision", "decision": "rule on the completed audit follow-through" }
```

- `/api/dispatch` (initial artifact dispatch — the fresh-audit shape)
- `/api/silas/directive` (bounded fix/repair phase)
- `/api/silas/rebrief` (fresh-worker phase)

Absent field ⇒ ordinary Silas completion (requirement: omission preserves
the current flow). Malformed/unknown kind ⇒ 400 before any job/side effect.
`decision` is the owned decision TEXT for the obligation — never identity,
never authority.

### 3.2 Durable phase-handoff guard row (migration 10)

One small guard table + one column, following the proven durable-marker
pattern (`pending_rebriefs`):

```sql
CREATE TABLE phase_handoffs (
  phase_id        TEXT PRIMARY KEY,          -- host-owned stable id
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  source          TEXT NOT NULL CHECK (source IN ('dispatch','silas-directive','silas-rebrief')),
  request_id      TEXT,                      -- directive request id (provenance/correlation)
  generation      INTEGER NOT NULL,          -- per-job monotonic phase generation
  decision        TEXT NOT NULL,             -- owed decision text (no authority)
  state           TEXT NOT NULL CHECK (state IN ('awaiting','completed','closed')),
  intent_seq      INTEGER NOT NULL,          -- events.seq watermark at intent acceptance
  minion_id       TEXT,                      -- bound admitted worker (dispatch path)
  completion_seq  INTEGER,                   -- correlated job.delivered seq
  obligation_id   TEXT,                      -- the owed job_obligations row
  notification_id TEXT,                      -- the published action-required row
  close_reason    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
ALTER TABLE pending_rebriefs ADD COLUMN phase_id TEXT;
```

Identity: `phaseId = phase-handoff:<jobId>:<source>:<generation>` (host
minted inside the writer transaction; monotonic generation per job). A
replayed directive request id maps to its existing row; a genuinely new
rebrief request advances the generation and closes the superseded phase.

Why not reuse `job_obligations` AS the pre-completion intent: that table's
vocabulary is blocked-lane debt (state machine, adoption, projections), and
a waiting row on a healthy working lane would leak into the FOR YOU / digest
consumers this and sibling lanes (#135/#142/#144) are building. This delta
REUSES the obligation record for the debt itself, plus the guarded-marker
pattern for the intent, and adds no second scheduler/outbox/inbox.

### 3.3 Completion is validated, not inferred

A phase completes only when a CORRELATED terminal delivery event exists:

- event kind `job.delivered`, `payload.phase_id === phase.phaseId`,
  `event.seq > phase.intentSeq`;
- `payload.source === phase.source`;
- admission validation per source:
  - `silas-directive`: the durable directive request (`request_id`) exists,
    belongs to the job, is `admitted` or `settled`, and the delivery's
    `request_id` matches;
  - `silas-rebrief`: a `silas.rebrief` event carrying the same `phase_id`
    postdates the intent (failured/interrupted rebriefs record none);
  - `dispatch`: the phase's bound `minion_id` exists and the delivery's
    `agentId` matches it.
- `job.delivered`, HTTP success/timeout, idle, a nonempty file or an
  assistant claim alone can never complete a phase: there is no phase to
  match without the persisted intent, and admission/correlation gates the
  rest. No new runtime attestation interface is invented; the existing
  service-recorded, request-correlated delivery evidence is reused. (For a
  crash mid-dispatch where no admission evidence exists, nothing is
  fabricated — see limitations §7.)

Failed/error-settled attempts: a dispatch turn failure closes its phase
(`close_reason`); a rebrief turn failure leaves markers (existing recovery)
and records no `silas.rebrief`, so no completion; a failed directive closes
its phase; a disposed/interrupted turn stays awaiting (admission unknown —
a late correlated delivery may still be genuine, the PR133 shape).

### 3.4 Owed decision + publication recorded together, reconciled at boot

On completed phase, in order, each step idempotent:

1. `completePhaseHandoff` (awaiting → completed, `completion_seq`);
2. obligation upsert via `recordBlockedObservation`:
   `incidentKey = phase-handoff@<phaseId>`, category `phase-completion`,
   firing rule `phase-completion-gru-decision`, `nextAction = {gru-decision,
   decision}`, `observedAtSeq = completionSeq`, no authority;
3. `job.phase-handoff-obligation` records the obligation id on the phase row;
4. publish via `NotificationCenter.postIncident`, stable kind
   `silas.phase-handback.<phaseId>`, routing `action-required`, severity
   `info`, `dedupe: 'all'` (one logical card per phase forever — no fresh
   alert ids, no duplicate Gru turn), then record `notification_id`.

Guards re-checked at completion/publish time from durable state:

- terminal (`done`/`merged`) → obligation settled `job-terminal`, phase
  closed, NO notification;
- `parked` → obligation suspended (`explicit durable state`), phase closed,
  NO notification (owner stop stays owner-owned; explicit resume only);
- the hand-back never ACKs/resolves a notification, never resumes a lane,
  never touches owner-held rows; shown/ACK/disposition is not settlement.

Boot/sweep reconciliation (`reconcilePhaseHandoffs`, wired into the existing
boot sequence after directive reconciliation): every `awaiting` phase is
checked for its correlated completion evidence (finish the crash window
after the delivery commit); every `completed` phase missing its obligation
or its notification finishes those steps (crash windows after completion /
before publish). Bounded cursor pages, stable ids, no timers, no
re-dispatch, no new daemon. Live observation rides the existing EventBus
subscription; the legacy blocked observer skips any event whose `phase_id`
names an existing phase row (no double publication), and keeps its current
behavior for unmarked deliveries.

## 4. Exact file / interface map

| File | Change |
|---|---|
| `src/ledger/db.ts` | migration 10 (`phase_handoffs`, `pending_rebriefs.phase_id`) with the landing-collision note; no existing migration touched |
| `src/ledger/obligations.ts` | `CompletionHandoffIntent`, `parseCompletionHandoffIntent`, `PhaseHandoffSource/State`, `PhaseHandoffRecord`, `phaseHandoffId` — pure vocabulary next to the obligation vocabulary |
| `src/ledger/api.ts` | `beginPhaseHandoff` (idempotent by request id; monotonic generation), `getPhaseHandoff`, `listPhaseHandoffs` (states + rowid cursor), `findPhaseHandoffByRequest`, `bindPhaseHandoffMinion`, `completePhaseHandoff`, `markPhaseHandoffObligation`, `markPhaseHandoffPublished`, `closePhaseHandoff`; `beginDirectiveIntent` optional `handoff` (same transaction); `beginPendingRebrief` optional `handoff` + `phase_id` on markers (same transaction; supersedes the prior awaiting rebrief phase); `PendingRebriefRecord.phaseId` |
| `src/dispatch/obligations.ts` | `observePhaseCompletion`, `reconcilePhaseHandoffs`, shared `settlePhaseCompletion`/publish routine; `observeFollowUpDelivery` skip when the event names an existing phase row |
| `src/dispatch/service.ts` | `dispatch()` optional `completionHandoff`: begin phase before spawn, bind minion after spawn, stamp `phaseId` on the delivery, close on failure |
| `src/dispatch/fix-directive.ts` | `recordFollowUpDelivery` optional `phaseId` → payload `phase_id` (additive) |
| `src/dispatch/rebrief-recovery.ts` | stamp `phase_id` on `silas.rebrief` + delivery; delivery-only boot recovery passes the marker's phase id |
| `src/dispatch/server.ts` | parse `completion_handoff` on `/api/dispatch`, `/api/silas/directive`, `/api/silas/rebrief` (400 before side effects); close the phase on a durable directive failure |
| `src/main.ts` | observer wiring (phase first, legacy fallback) + boot `reconcilePhaseHandoffs` after `reconcilePendingDirectives` |
| `docs/LEDGER.md` | migration-10 contract, states, crash-window guarantees, non-claims |
| `resources/silas-skills/ops-dispatch/SKILL.md` | document `completion_handoff` on directive/rebrief |
| `test/phase-handoffs.test.ts` (new) | deterministic coverage §5 |
| `test/dispatch-server.test.ts` | +2 HTTP-level tests (marking + malformed 400); pin bumped exactly |
| `test/suite-shape.test.ts` | new pin for `phase-handoffs.test.ts`; `dispatch-server.test.ts` pin bump |

## 5. Test map (deterministic; written here, executed via /api/verify later)

New file `test/phase-handoffs.test.ts` (real `LedgerDb` on tmpdir, in-memory
bus, explicit event watermarks, no clocks/providers):

1. marked dispatch phase (fresh artifact, no commit/PR, working→delivered)
   completes → ONE `phase-completion` obligation with the intent's decision
   + ONE action-required card; replay of the same delivery coalesces; an
   unmarked dispatch delivery records nothing.
2. marked rebrief on a BLOCKED lane and on a NONblocked lane both hand back;
   an unmarked blocked rebrief keeps the legacy hand-back and a marked one
   does not double-publish.
3. directive admission gate: a correlated delivery while the request is
   `dispatching`/`failed` does not complete; after recorded admission it
   completes once.
4. failure settles: dispatch/`minion-error` closes the phase (no hand-back);
   an error-only event cannot masquerade as completion.
5. crash windows: (a) delivery committed with the phase still `awaiting`
   (no observer ran) → boot reconciliation completes + publishes exactly
   once; duplicate delivery events coalesce; (b) phase `completed` with no
   `notification_id` → boot publishes exactly once.
6. guards: terminal job → phase closed, no card; parked job → phase closed,
   obligation suspended, no card; a closed/superseded phase is not completed
   by a late receipt; a delivery for phase A never completes phase B (newer
   phase vs older receipt).
7. disposition is not settlement: showing/acking the hand-back card leaves
   the obligation open; explicit accepted-evidence settlement closes it.
8. vocabulary/API validation: `parseCompletionHandoffIntent` rejects
   malformed shapes; `beginPhaseHandoff` replays by request id and conflicts
   on changed decision; binding/completion on a closed phase fails loud.
9. rebrief marker binding: `beginPendingRebrief` with a handoff writes the
   markers and the phase atomically; `finalizeRebriefRequest` stamps
   `phase_id`; a newer rebrief supersedes the older awaiting phase.
10. legacy observer skip: a marked blocked delivery posts exactly one card
    (the phase one), never the event-sequence card.

`test/dispatch-server.test.ts`: `/api/dispatch` with a valid
`completion_handoff` persists the phase before the minion turn and answers
202; a malformed field answers 400 with no job row created.
`test/suite-shape.test.ts`: pins updated to the exact registered counts.

Fail-before/pass-after is captured through Silas's authenticated `/api/verify`
path at a clean frozen head — not in this worker session (source-only).

## 6. Acceptance mapping (A–F)

- A: fresh explicitly chief-bound dispatch, no commit/PR, working→delivered
  → §5.1, service code only, no watcher/minion callback/user ping.
- B: marked same-head rebrief on blocked AND nonblocked jobs → §5.2; the
  narrower blocked hand-back preserved, no double publication.
- C: ordinary unmarked work → §5.1/§5.2 negatives; no spurious Gru/owner row.
- D: crash before/after intent, admission, completion, obligation write and
  publication, duplicates/out-of-order → §5.5/§5.6/§5.9; one logical handoff,
  no re-dispatch, no duplicate Gru turn, no lost obligation.
- E: error-only/partial/disposed settlement, stale/superseded generation,
  cancellation, terminal, parked/owner hold → §5.4/§5.6; no false success,
  no revived terminal lane, no owner ACK or unauthorized resume.
- F: shown/ACK/disposition alone → §5.7; the obligation stays owed until
  accepted evidence settles it; no artifact/notification text is approval.

## 6b. Shared surfaces touched — coordination status

This delta edits branch-local copies of surfaces other active lanes also
touch. Nothing here edits, copies or assumes deployed any other lane's
branch; the final integration must reconcile them at merge time. Pinned
context read (read-only, via each PR's diff at its current head):

- **#142 terminal-rebrief-retirement** (`gru/terminal-rebrief-retirement`,
  draft) edits `rebrief-recovery.ts`, `server.ts`, `api.ts`, `main.ts`,
  `docs/LEDGER.md` and tests — it retires stale re-brief requests on
  terminal jobs. Overlap: the same files, adjacent seams. This delta keeps
  the existing terminal refusal and adds only the phase fence/close; the
  two changes are semantically disjoint but will need a merge pass.
- **#144 review-rebrief-interlock** (`gru/review-rebrief-interlock`,
  draft) edits `branch-idle.ts`, `silas-driver.ts`, the ops-dispatch
  skill and tests — it fences review eligibility/admission on unresolved
  re-briefs. Overlap: `resources/silas-skills/ops-dispatch/SKILL.md`
  (documentation only; different sections) and suite pins. No code-level
  conflict with the phase guards.
- **#135 provider-pacing** (`gru/provider-pacing`, draft) edits
  `fix-directive.ts`, `rebrief-recovery.ts`, `server.ts`, `service.ts`,
  `main.ts`, config and tests for runtime pacing/retry. Overlap: shared
  files, different seams (admission gates/rate limits). No semantic
  dependency; merge-order coordination only.
- **#132 recovery/schema** — migration 10 is additive and carries the
  same landing-collision note as migration 9; renumber on integration if
  another lane lands first.

## 7. Explicit limits and non-claims (honesty)

- No new runtime attestation interface was invented. For a crash mid-turn
  where no admission evidence exists, the phase stays `awaiting` (never a
  fabricated success); directive/rebrief admission-unknown is already
  escalated by the existing bounded reconcilers. A dispatch crash mid-turn
  leaves the job's own state visible; this delta does not add dispatch-lane
  provider recovery (a wider runtime change that returns to Gru if wanted).
- No live migration, deployment, restart, service/agent mutation, provider
  call, credential use or owner notice in this session. Migration 10 is
  additive and is exercised only by tests/CI until ops admits a restart.
- Attribution limits unchanged: the shared bearer means `by`/source text
  never proves identity; the intent is caller-supplied but the phase
  identity/completion evidence is host-owned and ledger-validated.
- This document does not claim full-undergoing completion, review clearance
  or merge readiness. Final exact-head focused/FULL, CI, independent BMAD
  and native Perkins gates remain separate and external.
