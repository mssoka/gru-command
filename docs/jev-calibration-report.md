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
| 6 | `~typesafe/jev-latest` alias + noul-criteria record             | **200 — real completion** ✅ (served the same snapshot)                                               |
| 7 | post-r1 receipted demo (evidence completeness)                  | **200 — real completion** ✅ (chatty_ok again, noul 0.98, 534 ms)                                      |
| 8 | probe-script verify run during r1 fixes                          | **200 — real completion** ✅ (script exit-0 gate; see REPAIR_LOG for the clobber incident it exposed)  |

Raw evidence: [`tools/jev-pilot/evidence/access-probe.json`](../tools/jev-pilot/evidence/access-probe.json)
(bundle: request bodies, HTTP status, raw response bodies, latency, cost,
attempt ladder incl. a post-r1 receipted demo), plus per-attempt
`.headers`/`.body` (and `.meta` for the curl-metered attempts) files
alongside it. Reproduce with one command:
`node tools/jev-pilot/decisions-client.mjs --demo` (~$0.00003/run);
receipt-capturing probe: `bash tools/jev-pilot/probe-access.sh`
(writes tagged `rsp-decisions-$OUT_TAG.*` files, exits non-zero on any
non-200/error body, never clobbers prior runs).

Evidence hygiene (Perkins r1): `user_id` values and `set-cookie` lines are
redacted in place across raw receipts (non-credential identifiers; counts
in the bundle's `redaction_log`) — every other byte is as-received. One
repair is logged in the bundle's `REPAIR_LOG`: the original bundle's
attempt-4 entry had mis-paired the Zod-400 response with the post-hoc
corrected request body; it now carries the bytes actually sent
(`req-jev-1-13.json`, unchanged on disk since attempt 1).

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

Measured envelope (receipted runs): **330–534 ms**, **~$0.00003 per call**
(~660 input tokens) — 328 ms (attempt 5, `rsp-decisions-final.meta`) and
534 ms (post-r1 demo, `rsp-demo-post-r1.meta`). Sub-second, effectively
free at pilot scale — consistent with the edge-analysis doc's claims.

## Amendment 2 — docs kit verified and encoded at the interface level

The vendor docs Silas relayed were fetched and verified verbatim
(2026-09-19): [confidence.md](https://docs.typesafe.ai/confidence.md),
[jev-1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md),
[confidence-routing.md](https://docs.typesafe.ai/patterns/confidence-routing.md),
plus [parallel_questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md)
for the batching figure (12.2x cheaper, 10.0x faster). Key confirmations,
with our own receipts as primary evidence:

- **Confidence semantics (A):** our raw receipts show noul answers ship
  `{type, noul}` — **no confidence field** — while choice/score carry both
  `probabilities` and `confidence`. The client encodes this as types + a
  `decisionMetric()` dispatcher: noul gates threshold on probability,
  choice/score on confidence; both stay exposed, never collapsed (a test
  proves noul routing is invariant to a bogus confidence field).
- **Three-path routing (A):** `routeDecision(answer, riskClass)` →
  act / confirm / fallback-to-deterministic, thresholds **per risk class**:
  `read_only` (low bar), `operational`, `destructive` (act ≥ 0.85 **and**
  `require_confirm_on_act` — every passable band carries the human
  pause-and-ask; "Jev triages, never verdicts" made mechanical).
- **Jev-1.13 jaggedness (B):** encoded as the machine-readable
  `QUESTION_DESIGN_RULES` export (literal criteria, math/dates in code,
  filter state, adversarial caveat, aligned criteria, no cross-question
  invariants, atomic questions — each citing its vendor doc section).
  `routeDecision` deliberately takes ONE answer; an answers bag is a type
  error. **Adversarial caveat flagged hard:** the vendor does NOT treat
  state as hostile — the destructive-call gate must be tested against
  adversarial command text before anything load-bearing routes on it
  (test requirement written into Play C's question design).
- **Batching economics (C):** batched question sets are the client's
  default shape; single-question calls trigger a warning citing the
  cookbook figure. Our receipts back the shape: 3 questions, one call,
  ~$0.00003 total.

Interface encoding: `tools/jev-pilot/decisions-client.mjs` +
`tools/jev-pilot/decisions-client.test.mjs` — **23 offline tests on the
real receipt fixtures** (`node --test tools/jev-pilot/decisions-client.test.mjs`
— file-path form; the directory form MODULE_NOT_FOUNDs on Node 22),
covering the transport too (fetch-stubbed happy path, HTTP-error throw,
timeout abort, envelope validation), zero paid calls needed.

## Honest money ledger

| Item                                | Spend        |
| ----------------------------------- | ------------ |
| Attempt 5 (schema-correct first 200)| $0.000026292 |
| `~jev-latest` receipt call          | $0.000027636 |
| `decisions-client.mjs --demo` run #1| $0.000027636 |
| `decisions-client.mjs --demo` run #2 (post-Amendment-2 smoke) | $0.000027636 |
| Post-r1 receipted demo run (evidence completeness) | $0.000027636 |
| Probe-script verify run during r1 fixes (attempt 8) | $0.000026292 |
| **Total lane spend**                | **$0.000163** |

Ceiling was $10; actual **$0.000163** (attempts 1–4 were free 400s;
the r1 test suite runs offline on receipt fixtures). The economics claim
in the edge-analysis doc ("thousands of probes/month ≈ still zero") holds
as measured.

## Lane residue (what ships in this PR)

- `tools/jev-pilot/decisions-client.mjs` — minimal zero-dep decisions
  client: key resolution (env → factory keychain, endpoint-restricted),
  pre-flight question/state validation against the live schema, batched
  `decide()` with envelope validation + `--demo`, and the Amendment-2
  interface encoding (`decisionMetric`, three-path `routeDecision` with
  REQUIRED explicit risk class, `RISK_CLASSES`, `QUESTION_DESIGN_RULES`,
  batch warn).
- `tools/jev-pilot/decisions-client.test.mjs` — 23 offline tests: the
  Amendment-2 semantics on real receipt fixtures, plus fetch-stubbed
  transport coverage (happy path, HTTP error, timeout abort, envelope
  rejection, endpoint allowlist, key precedence, adversarial
  byte-identical passthrough asserted on the captured request).
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
   default; endpoint/model/timeout + **per-risk-class `[decisions.thresholds.*]`
   with three-path routing and `require_confirm_on_act` on destructive**).
3. Jev-backed implementation using the reference client's semantics:
   fail-open on any error/timeout, type-dispatched gate metrics (noul →
   probability, choice/score → confidence), batched question sets, one
   probe-gate call at boot when enabled.
4. The installer's runtime-detect offering the OpenRouter key checkbox
   (per the edge-analysis doc §3).
5. An adversarial-command-text test corpus for the destructive-call gate
   (Play C) — the vendor does not treat state as hostile (jaggedness #6).

Kill-switch doctrine stands: Jev triages, never verdicts; low confidence ⇒
escalate; probe before anything real depends on it.
