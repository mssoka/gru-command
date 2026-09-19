# DecisionService config-flag sketch — Jev fold-in seam

**Status:** SKETCH ONLY (Pilot 1 lane residue, 2026-09-19). Nothing here is
implemented in this lane. The fold-in is its own small, scheduled change
(Silas books it; per Amendment 1 the flag ships in v1.0.0 **default-off**
either way — access verified or not — because the fallback makes it inert).

**Context:** user ruling 2026-09-19 — the DecisionService seam is canon from
day one: event bus / supervisor / sweep pipeline / review-wave service call
through a `DecisionService` interface; deterministic default implementations
ship in v1; a Jev-backed implementation plugs in behind config, probe-gated,
optional per install, fail-open. Amendment 1 simplified the mechanism: ONE
config flag, same shape for us and end users, always reversible.

## The flag (TOML, in the repo's config idiom)

```toml
# gru.toml — decisions service (System One classifier seam; default OFF)
[decisions.jev]
enabled = false                    # THE flag. false = deterministic defaults, no network.
model = "~typesafe/jev-latest"     # user-confirmed slug; resolves to the pinned snapshot
endpoint = "https://openrouter.ai/api/alpha/decisions"  # alpha namespace, NOT chat/completions
timeout_ms = 2000                  # decisions must be fast; slow = fallback
min_confidence = 0.8               # below this, callers escalate to System 2 (fail-open)
```

## The interface it plugs into (sketch)

```ts
// src/decisions/service.ts (fold-in home — NOT this lane)
export interface DecisionService {
  /** Probe-read grade, alert pre-grade, sweep gate, findings triage.
   *  Implementations MUST be fail-open: any error/timeout/low-confidence
   *  resolves to the deterministic default + escalate signal, never a
   *  new failure mode. */
  decide(state: string, questions: QuestionSet): Promise<Decision>;
}
// Decision = { answers, confidence, source: 'deterministic' | 'jev' }
```

## Behavior matrix (the whole mechanism, per Amendment 1)

| Config / runtime state              | Behavior                                              |
| ----------------------------------- | ----------------------------------------------------- |
| `enabled = false` (default)         | deterministic defaults only; zero network, zero cost  |
| `enabled = true`, endpoint healthy  | Jev grades; confidence < `min_confidence` escalates   |
| `enabled = true`, unreachable/error | **fail-open to deterministic defaults**, log + notify |
| User flips the flag                 | Instantly reversible; no migration, no restart chore  |

## Wiring notes for the fold-in (from the access receipts)

1. **Endpoint:** `POST https://openrouter.ai/api/alpha/decisions` — the
   chat/completions endpoint 400s with "decisions model … use the
   /api/alpha/decisions endpoint instead" (receipt: `evidence/`, attempts
   1–3). Key: OpenRouter key (env `OPENROUTER_API_KEY`; the installer's
   runtime-detect can offer it as a checkbox per the edge-analysis doc).
2. **Question schema (live-verified):** every question carries
   `instructions`; `noul` → `criteria: {true, false}` descriptions;
   `choice` → per-option `criteria` record + `options[]`; `score` → ordered
   `criteria` rubric array. Missing/mistyped criteria = 400 Zod validation
   (receipt: attempt 4). Reference client: `tools/jev-pilot/decisions-client.mjs`.
3. **Cost/latency envelope (measured):** ~330–370 ms, ~$0.00003/call at
   ~660 input tokens. Budget 2 s timeout; a decisions call should never be
   the critical path's long pole.
4. **Probe-gate at startup** (standing doctrine): when `enabled = true`,
   one trivial decide() at boot; failure → log, notify, run deterministic
   (flag stays as-set; every call still fail-opens).
5. **Jev triages, never verdicts** (kill-switch doctrine): merges, Perkins
   verdicts and applicant decisions stay on execution proofs + humans.
