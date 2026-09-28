# Gate matrix — provider recovery sensor

Deterministic (fake clock / deferred / mock provider; no live calls, no
ambient credentials, no service spawn): these run under the normal backend
Vitest suite (`npm test` backend segment).

| # | Scenario | Deterministic coverage |
| --- | --- | --- |
| G1 | eligible quota rejection → wait persisted (identity, route, credential binding, incident generation, continuation ref, eligibility) | provider-wait recorder unit tests |
| G2 | valid recovery → one actual continuation, no owner ACK | scheduler + delivery + silas transition tests |
| G3 | multiple eligible waiters on one exact route → one shared check | scheduler cadence tests |
| G4 | zero waiters → polling stops; outstanding wait survives restart | scheduler lifecycle + restart tests |
| G5 | restart/claim/delivery boundaries (each boundary) | pending-delivery marker + boot reconcile tests |
| G6 | malformed/unknown/partial evidence cannot clear a wait | evidence gate tests |
| G7 | route/key rotation + stale completion | credential-generation binding tests |
| G8 | cancel / manual hold during probe and just before admission | eligibility invalidation tests |
| G9 | already-live replacement actor | admission recheck tests |
| G10 | stopped Silas (COO cannot take a turn) | logical-slot wait + pending delivery retention tests |
| G11 | capacity contention → one continuation first, fan-out only after model progress | guarded transition tests |
| G12 | renewed quota → back to wait/backoff | re-wait tests |
| G13 | probe budgets/timeouts/privacy (maxTokens 64, no tools/history, retries 0, finite timeout, fail-closed bounds) | probe envelope tests |
| G14 | auth/billing/expired-plan/ambiguous exclusions; no quota_wall blanket conversion; ACKed historical incidents untouched | classifier + migration tests |
| G15 | preserved failed-test/review gates after recovery; review-isolated attempts not respawned | gate preservation tests |
| G16 | cadence ceiling: no more than 12/hour/route, ≥300s spacing, Retry-After honored, bounded backoff | fake-clock cadence tests |

Broad/service-spawning verification (full `npm test` incl. build + web, e2e):
only through authenticated `/api/verify` with ≥36 GiB free AND a real
coordinated media/process-safe checkpoint through Silas requested BEFORE the
run. Complete output + nested `outcome.exitCode` captured. Every failed
attempt preserved verbatim; no direct broad/subset retries after failure; no
tail/tee exit laundering; no timeout/pool weakening; failures escalate for a
bounded ruling.

Final gates (not self-served by this worker):
- exact-final-head CI (push, observe Actions)
- fresh independent BMAD final-diff review
- required native Perkins review
- owner merge/deploy/activation (manual, owner-controlled)
