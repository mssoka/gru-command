# Nefario — the pre-dispatch briefing review

A heist briefing reaches its minion verbatim, and nothing tests it before a
lane builds against it. The only agent checking a briefing is the one who
wrote it, with the consult conversation to bias it, so ambiguity surfaces at
the most expensive moment: after the build, in review.

**Nefario** is a Gru-side, zero-context review of one briefing before
`POST /api/dispatch`. Lens minions read only the draft briefing, the
repository and an integrity-pinned lens method; their findings are
evidence-bound; and the result gates readiness. It is a readiness gate, never
a scope authority, and Perkins (post-delivery review) is untouched.

Source: GH-505. Internal identifier: `briefing-review`.

## The loop

1. **Gru commissions** a review of the exact briefing text with a declared tier
   and a one-line justification.
2. **Lenses run** as read-only planning jobs: each quotes the briefing for every
   finding and submits one verdict (READY or CHANGES-NEEDED).
3. **The review aggregates.** Any CHANGES-NEEDED is decisive at once; READY
   needs every armed lens to be READY.
4. **Gru routes** the result: fix the briefing and re-commission; or record a
   push-back with a reason when you judged the finding and are shipping as
   written. At the round cap, record a push-back on the last reviewed text,
   dispatch that exact text, and immediately append one material corrective
   amendment (`POST /api/dispatch/amendment`) that fixes that round's blocking
   findings; its `approval.reference` names owner ruling journal j-1200. A plain
   disagreement never escalates. The one exception is a finding whose content
   says the owner's requested outcome cannot be met as stated: it cannot be
   repaired by an amendment without changing the owner's scope, so escalate that
   finding and hold only the step it gates.
5. **Dispatch carries provenance**: the exact reviewed text, its sha and the
   round/verdict, recorded on the job.

## Endpoints

All authenticated with the instance `[auth]` token. Unknown subpaths are a
named 404 (`briefing_review_not_found`); a build without the feature wired is
a named 503 (`briefing_review_not_hosted`).

### `POST /api/briefing-review` — commission

```json
{ "repoPath": "/code/shop", "title": "Refunds endpoint", "tier": "medium",
  "justification": "Touches the refunds API and its tests.", "briefing": "…" }
```

`tier` is `low` (`stranger`), `medium` (`stranger`, `acceptance`,
`verification`) or `high` (all five: `stranger`, `acceptance`, `verification`,
`repo`, `scope`). Answers **202** with the review's identity and lens jobs when
a job was newly dispatched, **200** when the identical commission converged.

```json
{ "reviewId": "…", "commissionKey": "…", "briefingSha256": "…", "round": 1,
  "generation": 1, "tier": "medium", "lenses": ["stranger", "acceptance", "verification"],
  "headSha": "…", "jobs": [{ "lens": "stranger", "jobId": "briefing-review-…-stranger", "status": "working" }],
  "dispatched": true, "upgraded": false }
```

Identity is deterministic:

- `reviewId = sha256(briefing + "\0" + repoPath)` — one review per exact
  briefing and repository, across tier raises. **Convergence is by
  `reviewId`.**
- `commissionKey = sha256(briefing + "\0" + repoPath + "\0" + tier)` — the
  tier-scoped commission identity, recorded on every armed event.
- `briefingSha256 = sha256(briefing)` — the unit of provenance.
- `chainKey = sha256(repoPath + "\0" + title)` — the heist's revisions. A title
  reused for a different heist in the same repository within an open chain
  shares it; that caveat is deliberate (revise a heist under one title).
- Lens jobs are `briefing-review-<reviewId[0..32]>-<lens>`, tier-independent, so
  a raise reuses them.

A second commission of the same briefing converges: the newest armed generation
supplies the effective tier and lenses, the lens jobs and their live statuses
are reported, and no second job row, worktree or spawn is created. A lens job
row missing after a crash is dispatched on the retry. A **revised** briefing is
a new `reviewId`, a new round and new lens job ids; the prior round is
untouched.

**Tier raise.** Re-commissioning a *live* review at a higher tier appends one
armed event with the same `reviewId`, round and sha, the union of the lenses,
`generation + 1` and `upgradedFrom`; only the newly added lenses get jobs and
their results are inherited. A lower-tier re-commission returns the effective
higher tier and never removes a lens. A **decided** review refuses a raise with
409 `briefing_review_decided` — revise it (CHANGES-NEEDED) or dispatch it
(READY).

**Round cap.** `round` starts at 1 per chain. Three trailing CHANGES-NEEDED
rounds mean the briefing is not converging, not that it needs another polish:
the next revision is refused 409 `briefing_review_round_cap`. At the cap,
record a push-back on the last reviewed text, dispatch that exact text, then
immediately append one material corrective amendment
(`POST /api/dispatch/amendment`) that fixes that round's blocking findings; its
`approval.reference` names owner ruling journal j-1200. A plain disagreement
never escalates. A finding whose content says the owner's requested outcome
cannot be met as stated cannot be repaired by an amendment without changing the
owner's scope, so it takes the owner-escalation path; escalate that finding and
hold only the step it gates. A READY verdict ends the streak. An exact
re-commission of a decided review still converges.

### `POST /api/briefing-review/result` — one lens result

```json
{ "repoPath": "/code/shop", "briefingSha256": "…", "jobId": "briefing-review-…-stranger",
  "lens": "stranger", "verdict": "CHANGES-NEEDED",
  "findings": [{ "code": "undefined-empty-case", "severity": "blocking",
                 "evidence": "GET /api/refunds returns the caller's own refunds",
                 "why_it_blocks": "the lane cannot tell what an empty history returns" }] }
```

- Every finding is exactly `code` (1–80, `^[A-Za-z][A-Za-z0-9_.:-]*$`),
  `severity` (`blocking` | `advisory`), `evidence` and `why_it_blocks`
  (1–1000). At most 50 findings per result; unknown fields are a 400.
- **`evidence` must be a verbatim span** of the reviewed briefing, 8–2000
  characters after trimming end whitespace, for every finding (blocking and
  advisory alike). The span is read from the exact text stored on that lens job
  row between the review's markers `<<<NEFARIO-BRIEFING <reviewId>>>` and
  `<<<END NEFARIO-BRIEFING <reviewId>>>>`, so a quote from the helper or the
  standing orders cannot pass. A non-span is 400 naming the finding index.
- `READY` with a blocking finding, or `CHANGES-NEEDED` without one, is a 400.
- The job id must be that lens's deterministic job (409
  `briefing_review_job_mismatch`), the row must exist (409
  `briefing_review_not_dispatched`), and the lens must be in the armed set
  (400 `briefing_review_lens_unknown`).
- An identical retry returns the same 200 and appends nothing; a different
  result for the same lens is 409 `briefing_review_result_conflict`.

**Aggregation.** Any CHANGES-NEEDED is decisive immediately. READY becomes
decisive when every armed lens holds READY for the review (inherited results
count). One decisive verdict exists per `(reviewId, generation)`; later lens
results are recorded but never re-decide it. A decisive verdict posts one
`action-required` notification, `briefing-review:<reviewId>:<generation>`,
naming the verdict, round, tier, review, sha, the lens jobs and the routing
guidance. A decisive READY carries `caught`: the blocking findings of the
immediately preceding CHANGES-NEEDED round of the same chain that this revision
superseded (0 when nothing was superseded).

### `POST /api/briefing-review/pushback` — Gru's recorded override

```json
{ "repoPath": "/code/shop", "briefingSha256": "…", "reason": "Owner ruled this shape.", "by": "gru" }
```

The recorded-override path. It records one durable reason (1–2000 characters), is
idempotent by reason, refuses a READY review (409
`briefing_review_already_ready`), conflicts on a different reason for the same
review and generation (409 `briefing_review_pushback_conflict`), and lets a
an enforced-stage dispatch of the exact sha proceed. It never changes the review's
findings or the scope.

## Staged dispatch gate

`POST /api/dispatch` accepts an optional block:

```json
{ "briefing_review": { "rounds": 1, "verdict": "READY", "briefing_sha256": "…" } }
```

A present-but-malformed block is a named 400 before any side effect. When a
block is supplied:

| Situation | Answer |
|---|---|
| `briefing_sha256` differs from sha256 of the briefing being dispatched | 409 `briefing_review_mismatch`, naming both values |
| no armed review for that `reviewId` | 409 `briefing_review_unknown` |
| `rounds` differs from the record | 409 `briefing_review_mismatch` |
| a verdict the review does not hold | 409 `briefing_review_pending` (a false claim is never accepted, **in stage 1 too**) |
| the review was pushed back and the block is still supplied | 400 `briefing_review_invalid_request`; dispatch with no block so the push-back is auto-attached |
| matching READY | admitted, recorded |
| matching CHANGES-NEEDED, stage 1 or an advisory tier | admitted, recorded (advisory) |
| matching CHANGES-NEEDED, enforced tier at the active stage | 409 `briefing_review_not_ready` |

**Stage 1** (`stage = 1`) never refuses a dispatch for review
readiness — including a high-tier review that is pending or CHANGES-NEEDED. A
READY review or a recorded push-back attaches by itself even when the caller
omits the block. **Stage 2** also refuses a high-tier dispatch whose exact
briefing sha has no READY verdict and no push-back, **before any job row,
worktree or spawn**, with 409 `briefing_review_pending` (no verdict yet),
`briefing_review_not_ready` (CHANGES-NEEDED) or `briefing_review_required` (an
older round covers the chain but not this sha), plus one
`briefing.review-refused` event. **Stage 3 and the default `stage = "auto"`**
enforce medium as well as high; `auto` enforces every non-low tier (so a tier
added later is covered without a config edit), while 3 pins today's high +
medium set. Low stays advisory at every stage, and a heist with no armed review is
admitted — the server cannot infer an undeclared tier, so the role canon carries
that obligation.

Every admitted dispatch that carries provenance records one
`briefing.review-dispatched` event and the job holds the exact reviewed text, so
the ledger proves the minion received what was reviewed. Auto-attach is by exact
`reviewId`, which binds the repository: a foreign repository's review for the
same briefing text is never attached.

Cutover: the default is `stage = "auto"` — high and medium are enforced
immediately, low is advisory. Set `stage = 1` (advisory), `2` (high only) or
`3` (force high + medium) to override the tier-derived policy. Before a flip,
in-flight reviews at the newly enforced tier are revised or pushed back.

## Lens sessions

Each lens is a fresh `deliverable: "investigation"` planning job dispatched with
a real read-only standing order (change nothing, commit nothing, push nothing,
open no PR, implement nothing). Its briefing carries the reviewed text verbatim
between the markers, that lens's question, the verified GC helper section, the
identity stamp and the result-submission contract (endpoint, Bearer token,
exact body, retry rule). It carries no consult transcript, no prior-round
findings and no other lens's questions or findings. Nefario adds no role file:
lens jobs run `roles/minion.md` through the normal dispatch path.

The lens method ships at `resources/gc-workflows/skills/briefing-review/lenses.md`,
is integrity-pinned in `resources/gc-workflows/runtime.json` (package `@4`), and
its package id + sha256 are named in every lens briefing. A missing or
unverifiable helper refuses the commission with 503
`briefing_review_workflow_unavailable` and dispatches nothing. Provenance and
attribution are in `resources/gc-workflows/NOTICE.md`.

## Configuration

```toml
[briefing_review]
enabled = true   # false is the stop state: commission 503, gate admits, zeroed card
stage = "auto"   # auto follows the tier (high + medium enforced, low advisory); 1/2/3 override
```

Both keys are validated loudly (`docs/CONFIG.md`). `enabled = false` stops
commissioning entirely; the gate then admits everything and the cockpit card
shows zeros. Neither key can make the review change scope or overrule an owner
ruling.

## On the board

The cockpit's **NEFARIO** card (`docs/BOARD.md`) shows how many reviews are
under test, the newest live round and tier (suffixed `· advisory` at stage 1),
today's verdicts, the findings caught before dispatch, and — at any
enforced stage — the refusals. A server that cannot read the events sends
`briefingReview: null`
(dashed `unavailable` card); an older server sends no block at all (no card).
There are no per-lens chips.

The snapshot's `briefingReview.stage` is `'advisory' | 'high' | 'high+medium'`:
stage 1, stage 2, and auto/stage 3 respectively. This is the first Nefario
service, so there is no compatibility shim for the unshipped `'medium'`
spelling.

## Refusal vocabulary

| Code | Status | When |
|---|---|---|
| `briefing_review_not_hosted` | 503 | the review is not wired on this service |
| `briefing_review_disabled` | 503 | `[briefing_review] enabled = false` |
| `briefing_review_workflow_unavailable` | 503 | the verified lens helper is missing or unreadable |
| `briefing_review_invalid_request` | 400 | malformed commission/result/push-back, unknown field, out-of-bound value, or a block supplied on a pushed-back review |
| `briefing_review_not_found` | 404 | unknown subpath |
| `briefing_review_not_commissioned` | 409 | a result or push-back with no armed review |
| `briefing_review_not_dispatched` | 409 | the result's lens job row (or its marked briefing) is missing |
| `briefing_review_job_mismatch` | 409 | the result's job id is not that lens's deterministic job |
| `briefing_review_lens_unknown` | 400 | a lens outside the armed set |
| `briefing_review_result_conflict` | 409 | a different result for the same review and lens |
| `briefing_review_decided` | 409 | a tier raise on a decided review |
| `briefing_review_round_cap` | 409 | a fourth revision after three trailing CHANGES-NEEDED rounds |
| `briefing_review_already_ready` | 409 | a push-back on a READY review |
| `briefing_review_pushback_conflict` | 409 | a different push-back reason for the same review and generation |
| `briefing_review_mismatch` | 409 | provenance sha or `rounds` differs from the record |
| `briefing_review_unknown` | 409 | claimed provenance with no armed review |
| `briefing_review_pending` | 409 | a claimed verdict the review does not hold; a pending review at an enforced stage |
| `briefing_review_not_ready` | 409 | a CHANGES-NEEDED review at an enforced stage |
| `briefing_review_required` | 409 | an enforced-tier chain whose exact sha has no review |

## What this never changes

Perkins' policy, resources and post-delivery flow; intake owner approval; merge
authority; the single-writer rule; the verbatim-briefing contract. No runtime
dependency is added, no second review of diffs exists, and no low-tier dispatch
is ever mandated.
