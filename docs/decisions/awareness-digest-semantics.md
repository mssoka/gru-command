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
