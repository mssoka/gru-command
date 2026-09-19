# DecisionService config-flag sketch — Jev fold-in seam

**Status:** SKETCH ONLY (Pilot 1 lane residue, 2026-09-19; Amendment 2
docs-kit encoding folded in). Nothing here is implemented in this lane.
The fold-in is its own small, scheduled change (Silas books it; per
Amendment 1 the flag ships in v1.0.0 **default-off** either way — access
verified or not — because the fallback makes it inert).

**Context:** user ruling 2026-09-19 — the DecisionService seam is canon from
day one: event bus / supervisor / sweep pipeline / review-wave service call
through a `DecisionService` interface; deterministic default implementations
ship in v1; a Jev-backed implementation plugs in behind config, probe-gated,
optional per install, fail-open. Amendment 1: ONE config flag, same shape
for us and end users, always reversible. Amendment 2: confidence semantics,
per-risk-class thresholds, batching, and the jev-1.13 jaggedness rules are
**interface-level requirements** (vendor docs fetched + verified 2026-09-19:
`docs.typesafe.ai/confidence.md`, `docs.typesafe.ai/model-jaggedness/jev-1.13.md`,
`docs.typesafe.ai/patterns/confidence-routing.md`,
`docs.typesafe.ai/cookbooks/parallel_questions.md`).

## The flag (TOML, in the repo's config idiom)

```toml
# config.toml — decisions service (System One classifier seam; default OFF)
# (the repo's config file is config.toml — see src/config.ts configPathFor
#  and docs/example.config.toml)
[decisions.jev]
enabled = false                    # THE flag. false = deterministic defaults, no network.
model = "~typesafe/jev-latest"     # user-confirmed slug; resolves to the pinned snapshot
endpoint = "https://openrouter.ai/api/alpha/decisions"  # alpha namespace, NOT chat/completions
timeout_ms = 2000                  # AUTHORITATIVE figure (the reference client default matches)
                                   # decisions must be fast; slow = fallback

# Amendment 2 — per-risk-class routing thresholds (three-path).
# metric: noul → probability; choice/score → confidence (confidence.md:
# noul answers carry NO confidence — gates must use the right field).
[decisions.thresholds.read_only]   # misroute is recoverable: low bar
act = 0.6                          # ≥ act → automatic
confirm = 0.4                      # ≥ confirm → flag / ask / gather; below → fallback

[decisions.thresholds.operational] # consumes ops turns / quota
act = 0.75
confirm = 0.55

[decisions.thresholds.destructive] # irreversible: high bar WITH confirm
act = 0.85                         # "~0.85 WITH confirm" (confidence-routing.md banking pattern)
confirm = 0.7
require_confirm_on_act = true      # even the act band pauses for the human (Jev triages, never verdicts)
```

## The interface it plugs into (sketch — types carry the Amendment 2 semantics)

```ts
// src/decisions/service.ts (fold-in home — NOT this lane)
// A. confidence ships on Choice/Score ONLY; Noul = probability only.
type NoulAnswer   = { type: 'noul';   noul: number };                       // no confidence field, by vendor contract
type ChoiceAnswer = { type: 'choice'; choice: string;
                      probabilities: Record<string, number>; confidence: number };
type ScoreAnswer  = { type: 'score';  score: number;
                      probabilities: Record<string, number>; confidence: number };
type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

// A. three-path routing; the metric is type-dispatched so callers cannot
// threshold the wrong field. Both probabilities AND confidence stay exposed.
type RoutePath = 'act' | 'confirm' | 'fallback';
interface Route { path: RoutePath; metric: number;
                  metricKind: 'probability' | 'confidence';
                  requiresConfirm: boolean }

// N26: the risk class is REQUIRED at the call site — an omitted class must
// never silently inherit the loosest thresholds (destructive answers
// routed without a class would act at read_only's 0.6 with no confirm).
// C. batched default shape: one call carries ALL questions (~12.2x cheaper,
//    ~10x faster — cookbooks/parallel_questions.md).
interface DecisionService {
  decide(state: string, questions: QuestionSet): Promise<{
    answers: Record<string, Answer>;      // per-question, typed
    route(qId: string, riskClass: keyof ThresholdsConfig): Route;  // A (class required)
    source: 'deterministic' | 'jev';      // fail-open: errors → 'deterministic'
  }>;
}
```

Reference implementation of the routing semantics (types, field dispatch,
risk classes, batch warn, endpoint-restricted auto-key, envelope
validation): `tools/jev-pilot/decisions-client.mjs` +
`decisions-client.test.mjs` (23 offline tests on receipt fixtures — run
with `node --test tools/jev-pilot/decisions-client.test.mjs`; the
directory form MODULE_NOT_FOUNDs on Node 22).

## Behavior matrix (the whole mechanism, per Amendment 1 + 2)

| Config / runtime state              | Behavior                                              |
| ----------------------------------- | ----------------------------------------------------- |
| `enabled = false` (default)         | deterministic defaults only; zero network, zero cost  |
| `enabled = true`, endpoint healthy  | batched Jev grades; three-path route per risk class   |
| `enabled = true`, unreachable/error | **fail-open to deterministic defaults**, log + notify |
| metric ≥ `act` (non-destructive)    | act automatically                                     |
| metric in `[confirm, act)`          | flag / confirm / gather — never silent                |
| metric < `confirm`                  | fallback to the deterministic default                 |
| destructive class, any passable band| **always carries human confirm** (`require_confirm_on_act`) |
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
   (receipt: attempt 4).
3. **Cost/latency envelope (measured):** ~330–520 ms, ~$0.00003/call at
   ~660 input tokens. Budget 2 s timeout; a decisions call should never be
   the critical path's long pole.
4. **Probe-gate at startup** (standing doctrine): when `enabled = true`,
   one trivial decide() at boot; failure → log, notify, run deterministic
   (flag stays as-set; every call still fail-opens).
5. **Jev triages, never verdicts** (kill-switch doctrine): merges, Perkins
   verdicts and applicant decisions stay on execution proofs + humans.

## jev-1.13 jaggedness rules — fold-in GUIDANCE (rides SPEC per Amendment 2)

Machine-readable list exported by the reference client as
`QUESTION_DESIGN_RULES` (each cites its vendor doc):

1. **Literal criteria** — state the exact condition in `instructions`; put
   boundary cases in criteria. jev-1.13 answers the question written, not
   the one meant. (`model-jaggedness/jev-1.13.md` #1)
2. **Arithmetic / counting / dates stay in CODE** — never the model; pass
   computed values or named buckets as state. (#2, #3)
3. **Filter state before sending** — unrelated detail is a distractor and
   costs accuracy (context rot). (#5)
4. **ADVERSARIAL CAVEAT** — the vendor does NOT treat state as hostile:
   injected instructions or self-arguing text can move the answer. Any gate
   over untrusted text — the destructive-call gate above all — must be
   tested against adversarial command text before depending on it. (#6)
5. **Aligned instructions/criteria** — inverted true/false mappings degrade
   accuracy. (#7)
6. **No cross-question invariants** — never compose a noul answer with a
   choice answer; a noul is absolute, a choice is relative; enforce
   identities in code. (#8)
7. **Atomic questions** — one gut-check judgment per question; decompose
   multi-factor judgments and combine in code.
