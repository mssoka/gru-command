# Yield report (GH-214)

What machine-initiated turns cost and achieve: per-trigger usage, follow-through
yield, Silas digest stability, Gru wake causes, and the heist north-star (M0).
This is the read-only Check step of the decision-cost program (GH-213) — every
phase of that program measures against this report.

The aggregation lives in `src/telemetry/yield.ts` (pure, fixture-tested); the
CLI wrapper is `src/cli/yield-report.ts`.

## Running it

```bash
npm run build   # once, so dist/ is current
npm run yield -- --since 2026-09-29T00:00:00Z --until 2026-10-06T00:00:00Z
```

Flags:

| Flag | Meaning |
|---|---|
| `--since <iso>` | required; window start (inclusive) |
| `--until <iso>` | window end (exclusive); defaults to now |
| `--data-dir <path>` | instance data dir; defaults to the configured `data_dir` |
| `--json` | machine-readable output instead of the text table |

Read-only by contract: the ledger is opened with `node:sqlite` in `readOnly`
mode (never written, never migrated) and session JSONL is only streamed.

## What it measures

- **Turn attribution.** Each session turn (one `user` message plus the
  assistant messages that follow it) is attributed to a trigger from the
  prompt prefix: Silas `trigger: <kind>`, Gru service wake vs
  awareness-tagged vs plain owner turn, Bob consolidation vs dream pass,
  Perkins lead vs lens, minion briefing vs re-brief vs other directive.
  Prompts are never printed — attribution reads only the prefix.
- **Usage per trigger.** Turns, LLM calls, tokens by class
  (input/output/cacheRead/cacheWrite/reasoning), list-price cost, and
  compactions, bucketed per trigger and per budget class
  (machine / delivery / owner) and per provider+model.
- **Yield.** For each `silas.wake` (and `gru.wake`) ledger event: whether any
  ops action (directive, re-brief, escalation, PR registration, review
  trigger, verification request, provider-recovery continuation, resolution)
  lands before the next wake in (timestamp, sequence) order. The no-action
  share is the waste signal from GH-213.
- **Digest stability.** Each Silas sweep prompt's fenced digest JSON is
  reduced to a signature (per category, sorted job IDs); the share of sweeps
  whose signature matches the previous sweep is the "wake without new
  information" measure that motivates GH-217.
- **Gru wake causes.** `gru.wake` notification IDs joined to
  `notifications.kind`: per-kind wake counts, conflict-only wakes (every
  notification a mechanical `github.pr-conflict*` alert — the GH-215
  target), and repeat incidents (the same notification ID waking Gru more
  than once). Issue #219 adds the cost headline: wakes per day over the
  window, and the avoided share — `gru.wake-deferred` events with reason
  `duplicate` (the incident was already woken) or `covered` (an active
  decision, GH-218, held the subject) over all wake demands in the
  window. A `failed` deferral is not avoidance: the demand stayed
  unserved and escalated.
- **M0 (north star).** Heists finished in the window (`job.status` moving to
  `merged|done`), created→terminal lead times, non-terminal WIP at the
  window end (replayed from events, by status with age), and cost per
  finished heist.

## Reproducing the GH-213 baseline

```bash
npm run yield -- --since 2026-09-29T00:00:00Z --until 2026-10-06T00:00:00Z
```

The 2026-10-05 baselines: ≈$1,047 total cost, ≈$575 machine-initiated (55%),
41 finished heists, 121 non-terminal WIP. The deterministic ledger counts are
exact for a fixed window (121 non-terminal reproduces exactly; the prose
"41 finished" is 40 over the exact verify window — an ad-hoc boundary
rounding in the original analysis). Cost figures depend on session files,
which are append-only, so past windows stay stable.

## Safety

Output is counts and bounded identifiers only (job IDs, trigger names,
notification kinds). Prompts, transcripts, token values, and secrets never
appear in the report; tests pin this (a sentinel planted in a fixture prompt
must not surface in text or JSON output).

## Coverage

The parser reads pi-session JSONL (the format every GC role writes today).
Sessions written in other runtimes' formats (for example a Claude Code
stream-JSON transcript) contribute no turns and no cost; if a runtime switch
ever happens, the parser must gain that format or the report will silently
understate. Cost figures cover what pi recorded per assistant message, so a
report over a past window is stable once its turns have finished streaming.

A board panel can follow later by rendering the same `--json` output.
