# Awareness morning digest semantics (PR71 review follow-ups)

Owner decision ladder: code first. These are recorded so they are never re-made.

## g7 (#104): what counts as an "action" in the digest

Decision: **only a durable `notification.resolved` event attributed `by: "gru"`
is a Gru action.** The digest renders it as `- Gru actions: N disposition(s)`
(plus the latest disposition's detail). Deliveries, status changes, round
verdicts (`MORNING_ACTION_KINDS`) and non-Gru resolutions are passive board
traffic, rendered separately as `- activity: N board event(s)`.

Rationale: the old `- actions: N board events` line could read as N completed
actions when Gru did nothing. No new event kinds; delivery is unchanged, only
the classification is honest.

## g15 (#111): first-ever owner digest baseline

Decision: **until the first owner turn is committed, the digest baseline is the
persisted install / first-start time** (`digest.baselineAt` in the awareness
state, written once on first boot and kept across restarts). `lastOwnerAt`
stays `null` (no synthetic owner turn); the digest uses
`lastOwnerAt ?? baselineAt` as `since`, with `lastOwnerSeq` (the covered
cursor, 0 on a fresh install) as the event watermark. History stays bounded by
the digest's existing 101-row caps ("100+") and time filters.

Rationale: a fresh install otherwise never gets a catch-up for its first
unattended interval. Install time (not process start) keeps a mid-night restart
from erasing that interval.
