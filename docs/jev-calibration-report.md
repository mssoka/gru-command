# Jev access verification — pilot lane report

**Lane:** `gru-command-jev-pilot` (off-belt, parallel with E9) · 2026-09-19
**Amendment 1 applied:** this lane was trimmed mid-flight — the
labeled-history replay and its ≥90 % pass/fail gate were DROPPED. Step 0
(the access gate) is the substance of the lane; the fold-in rule simplifies
to: **the config flag ships in v1.0.0 default-off either way** — access
verified or not — because the deterministic-default fallback makes it inert
until a user enables it. No PASS/FAIL ceremony below; this is the access
verification + the fold-in handoff.

## Verdict: ACCESS VERIFIED ✅

OpenRouter serves real Jev decisions completions. One nuance materially
differs from the briefing's assumption, and it matters for the fold-in:

> **Jev is NOT served via `/api/v1/chat/completions`.** It is served via a
> dedicated, currently-alpha endpoint: `POST https://openrouter.ai/api/alpha/decisions`.

This was discovered independently during the probe and then confirmed by
the user from the OpenRouter quickstart (Amendment 1). Both model ids
resolve on OpenRouter: `typesafe/jev-1.13` and the alias
`~typesafe/jev-latest` (recommended slug) — both served snapshot
`typesafe/jev-1.13-20260917` from upstream provider `TypeSafe`.

## How the route was found (attempt ladder — all receipts preserved)

| # | Attempt                                                        | Result                                                                                             |
| - | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1 | `chat/completions`, raw documented `{state, questions}` shape   | 400 `Input required: specify "prompt" or "messages"` — **model ids resolved** (no 404)              |
| 2 | same, `~typesafe/jev-latest` alias                             | identical 400 — alias resolves too                                                                  |
| 3 | documented shape inside the `messages` envelope                | 400 **"typesafe/jev-1.13 is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead."** |
| 4 | `/api/alpha/decisions`, raw shape                              | 400 Zod validation — exact schema revealed (see below)                                              |
| 5 | `/api/alpha/decisions`, schema-correct shape                   | **200 — real completion** ✅                                                                         |

Raw evidence: [`tools/jev-pilot/evidence/access-probe.json`](../tools/jev-pilot/evidence/access-probe.json)
(bundle: request bodies, HTTP status, raw response bodies, latency, cost,
attempt ladder), plus per-attempt `.headers`/`.body`/`.meta` files alongside
it. Reproduce with one command:
`node tools/jev-pilot/decisions-client.mjs --demo` (~$0.00003/run).

## The receipts (raw, unedited)

Served model `typesafe/jev-1.13-20260917` on the trivial Play-A fixture
(chatty "OK — I am here and working!"):

```json
{"model":"typesafe/jev-1.13-20260917","answers":{
  "provider_alive":{"type":"noul","noul":0.96},
  "read_class":{"type":"choice","choice":"chatty_ok","probabilities":{...,"chatty_ok":1},"confidence":1},
  "severity":{"type":"score","score":0,"probabilities":{"0":1,"1":0},"confidence":1}},
 "usage":{"input_tokens":626,"output_tokens":139,"cost":0.000026292},
 "id":"gen-dec-1789778139-WHrLNLMSgc6erVL54RiK","provider":"TypeSafe"}
```

Second receipt (`~typesafe/jev-latest` slug + noul-criteria record shape):
`noul 0.97`, same class pick, `$0.000027636`, `gen-dec-1789778187-JSlrW6U18kWg5kMbx6qu`.

Sanity read: the fixture was classified **correctly and with high
confidence** (chatty_ok @ 1.0, alive ~0.97, severity low) — the exact class
today's strict `^OK$` matcher mis-grades. This is a sanity signal only; per
Amendment 1 no agreement gate was run.

## Live-verified API shape (the part the fold-in must get right)

Request: `{"model", "state", "questions"}` where every question carries
`instructions` and typed `criteria`:

- `noul` → `criteria: { true: "...", false: "..." }` → answer: probability
- `choice` → `options: [...]` + `criteria: { <per-option> }` (record) → answer: pick + per-option probabilities + confidence
- `score` → `criteria: [ ordered rubric levels ]` (array) → answer: level index + distribution + confidence

Missing `instructions`, a record-where-array `criteria` (or vice versa)
yields a 400 Zod validation error whose payload handily spells out the
expected schema (receipt: attempt 4).

Measured envelope: **~330–370 ms**, **~$0.00003 per call** (~660 input
tokens). Sub-second, effectively free at pilot scale — consistent with the
edge-analysis doc's claims.

## Honest money ledger

| Item                                | Spend        |
| ----------------------------------- | ------------ |
| Attempt 5 (schema-correct first 200)| $0.000026292 |
| `~jev-latest` receipt call          | $0.000027636 |
| `decisions-client.mjs --demo` run   | $0.000027636 |
| **Total lane spend**                | **$0.000082** |

Ceiling was $10; actual $0.000082 (attempts 1–4 were free 400s). The
economics claim in the edge-analysis doc ("thousands of probes/month ≈
still zero") holds as measured.

## Lane residue (what ships in this PR)

- `tools/jev-pilot/decisions-client.mjs` — minimal zero-dep decisions
  client: key resolution (env → factory keychain), pre-flight question
  validation against the live schema, `decide()` + `--demo`.
- `tools/jev-pilot/config-flag-schema-sketch.md` — the `[decisions.jev]`
  TOML flag sketch in the repo's config idiom + the fail-open behavior
  matrix + fold-in wiring notes. Sketch only; **no provider implementation
  in this lane**.
- `tools/jev-pilot/question-design.md` — optional question-design input
  (Plays A–D shaped in the verified schema; Play A receipt-validated).
- `tools/jev-pilot/evidence/` — every raw request/response receipt.

## Fold-in handoff (per Amendment 1)

**The flag ships in v1.0.0, default-off** — trivial and safe; access is
verified, so flipping it on per-install is a supported path, not an
experiment. What the fold-in needs (scoped follow-up, NOT this lane):

1. `src/decisions/` — the `DecisionService` interface + deterministic
   default implementations (the shipped path), behind the existing seam
   ruling (event bus / supervisor / sweep pipeline / review-wave).
2. `[decisions.jev]` config section per the sketch (`enabled = false`
   default; endpoint/model/timeout/min_confidence).
3. Jev-backed implementation using the reference client's semantics:
   fail-open on any error/timeout, `min_confidence` escalates to System 2,
   one probe-gate call at boot when enabled.
4. The installer's runtime-detect offering the OpenRouter key checkbox
   (per the edge-analysis doc §3).

Kill-switch doctrine stands: Jev triages, never verdicts; low confidence ⇒
escalate; probe before anything real depends on it.
