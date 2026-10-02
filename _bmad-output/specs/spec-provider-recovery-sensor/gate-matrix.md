# Gate matrix — provider recovery sensor

> **Current integration epoch (2026-10-02): not ready.** The r4 fix round
> is complete in code — all nine r4 findings are dispositioned with
> deterministic coverage (two blockers: the wall-settled dispatch block
> keeps its wait and the claim resumes; four warnings: fresh-route async
> settlement, atomic-claim incident lifecycle, optional metadata bucket
> exhaustion, and the DORMANT native-Claude overlay marking; three notes:
> terminal-replay guard, dedupe-capable incident posts, endpoint-rotation
> re-bind). Exact head/base, verification receipts and review identities
> live in the approved delivery record. The coverage table below names
> existing tests; it is not execution evidence at the final head.
> **Native Claude overlay: DORMANT/UNSHIPPED** — the composed reader
> cannot fire (no runtime provider provenance; no resolvable pi catalog
> route), so no capability claim attaches to it. G11's fan-out gate is
> still source-only in production (cap-owned emitter ungrounded). Owner
> activation remains manual; no owner choice is reopened. Exact-final-head
> CI, fresh independent review, native Perkins and local `/api/verify`
> receipts are distinct gates; historical results do not inherit.

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

## Multi-provider overlay + r1 rework additions (2026-09-29)

| Scenario | Deterministic coverage |
| --- | --- |
| Codex metadata: strict schema accept/reject, exhausted vs available (reset hint), no fallback to generation, one GET, account-claim header binding | `provider-recovery-metadata.test.ts`, `provider-recovery-composition.test.ts` |
| Claude metadata: strict schema, required-window exhaustion, optional model windows never "unlimited", owner statuses preserve the hold | same |
| Codex/Claude snapshots: fake auth.json / fake keychain port only; API-key/expiry/override/wrong-kind/wrong-account rejections BEFORE I/O; fingerprint-fenced readers; rotation fails closed | `provider-recovery-composition.test.ts` |
| Machine ownership BEFORE any owner stop (zero needs-owner chimes for eligible waits; conservative needs-owner for auth/unsupported/failure) | `provider-recovery-seam.test.ts` |
| GLM fallback activation guard: default OFF performs ZERO provider I/O while a wait remains durable | `provider-recovery-sensor.test.ts` |
| ≤300 s floor on every outcome class; pre-I/O charge with crash settle (no refund/duplicate); post-I/O revalidation (rotation/holds applied); atomic batch binding all matching waiters; single delivery path; CAS claim before spawn | `provider-recovery-sensor.test.ts`, `provider-recovery-resume.test.ts`, `provider-recovery-ledger.test.ts` |
| Interrupted-turn churn (blocked/delivered after establishment) stays eligible; pre-existing/generic blocks hold with zero I/O | `provider-recovery-sensor.test.ts` |
| Typed provenance: SDK errors (status/headers) and provider terminal messages only; arbitrary exceptions anonymous | `pi-adapter.test.ts` (pure parsers) |
| Fan-out gate: all claim/actor/session-turn/route/generation bindings enforced | `provider-recovery-admission.test.ts` |
| Historical owner stops never resolved by the machine lifecycle; machine-owned incidents resolve with their wait | `provider-recovery-sensor.test.ts` |

## r4 fix-round addition (2026-09-30)

| Scenario | Deterministic coverage |
| --- | --- |
| A provider wall whose dispatch settle races the wait (the job is already `blocked` by this wait's own failing turn at establishment) keeps its wait: selection does not hold, the claim resumes instead of cancelling, and the lane re-opens blocked→working. Blocks WITHOUT that ledger attribution (no minion error, a different actor's error, or an intervening status hop) still hold/cancel. | `provider-recovery-sensor.test.ts` (2 new), `provider-recovery-resume.test.ts` (2 new); attribution helper `src/provider-recovery/settle-attribution.ts` |

Verified on the lane at head `3692718` (local, isolated pure suites):
`lint` green; both tsconfigs green; `build` green (incl. Perkins resource
verifier); 21 adjacent test files / 459 tests green (nine provider-recovery
suites = 198, plus supervisor, awareness, notifications, ledger-api,
ledger-db, silas-driver, pi-adapter, fix-directive, rebrief-recovery, health,
config, config-generate, suite-shape).

## r4 warning/note dispositions (2026-10-02)

| Finding | Scenario | Deterministic coverage |
| --- | --- | --- |
| w-dispatch-race | Real `DispatchService` + supervisor + sensor: the failed briefing turn settles `blocked` BEFORE the supervisor observes the typed provider error; the wait stays eligible, the shared check recovers it, and ONE guarded continuation runs (lane re-opened; admission recorded separately; machine incident resolved). | `provider-recovery-seam.test.ts` (real-seam) |
| w-async-settle | A completed recovery keeps the pre-I/O charged attempt and never reverts `incident_seq` / `false_recovery_count` / `suspended_until` updated mid-check. | `provider-recovery-sensor.test.ts` |
| w-incident-lifecycle | `claimProviderWaitAtomic` resolves the wait's OWN action-required incident (never an ACK; needs-owner rows stay open; lost CAS resolves nothing). | `provider-recovery-ledger.test.ts` |
| w-metadata-buckets | Exhausted optional model buckets hold only when they may cover the route model (unknown coverage fails closed); exhausted scoped limits hold; Codex null/empty optional buckets accepted while present unknown buckets fail closed; partial optional buckets fail the read closed. | `provider-recovery-metadata.test.ts` |
| w-scope-coverage | Native Claude overlay path marked DORMANT/UNSHIPPED in SPEC + gate matrix (no runtime provenance; no resolvable route). | this document + `SPEC.md`; `composition.ts` notice |
| n-terminal-replay | A same-incident replay on a terminal wait returns it unchanged (never revives). | `provider-recovery-ledger.test.ts` |
| n-dedupe | The notifications port uses the dedupe-capable incident post: repeated establishments keep one waiting row; repeated false-recovery escalations reuse one machine row. | `provider-recovery-sensor.test.ts` |
| n-endpoint-rotation | A catalog endpoint change re-binds the route row and retires stale waiting rows with a recorded reason; the next check probes the re-bound endpoint. | `provider-recovery-sensor.test.ts` |
| config-wiring | `probe_timeout_ms` reaches the GLM generation probe (the documented finite bound now governs it too; the probe port applies it to both the request option and the abort signal). | `src/main.ts` wiring; `test/provider-recovery-classify.test.ts` pins `PROBE_MAX_OUTPUT_TOKENS`/`PROBE_TIMEOUT_MS` bounds |

Fails-before evidence: the declared `provider-recovery-r4-baseline` scope
runs the current test sources against `git archive` snapshots of the
pre-fix commits with the vitest exit left intact (EXPECTED RED, never
masked); see the delivery record for the run ids and complete output.

Remaining gates (not self-served): exact-head CI, `/api/verify` receipts
(focused/typecheck/full) at the final head, fresh independent BMAD
final-diff review, required native Perkins review, owner
merge/deploy/activation.
