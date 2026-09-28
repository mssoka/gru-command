---
id: SPEC-provider-recovery-sensor
companions:
  - code-map.md
  - gate-matrix.md
  - adopted-briefing.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Provider recovery sensor

## Why

Approved Gru-command work has twice been interrupted by a temporary GLM provider limit on the installed `zai-coding-cn` China coding route, stranding approved resumable steps until the owner manually polled and ACKed. The owner twice said "go ahead" (owner-approval.json, 2026-09-28) after the probe-cost and eligible-wait explanations: this is ONE undertaking — a deterministic, in-service recovery sensor so eligible waits resume through Silas without routine owner polling or ACKs, while every owner-controlled stop class stays owner-controlled.

## Capabilities

- **CAP-1 explicit provider-wait state**
  - **intent:** The service can persist, from a real runtime provider rejection on an approved resumable step classified by a supported provider-aware classifier as a temporary recoverable limit, a durable wait record carrying job/step or logical-slot identity, exact provider/endpoint/model, non-secret credential binding, incident generation, saved continuation reference, and automatic-recovery eligibility.
  - **success:** A deterministic test feeds a structured provider rejection (e.g. HTTP 429 with quota semantics on the configured route) through the runtime error path and asserts a durable wait row exists with every named field; feeding generic blocked status, prose-only errors, or queue membership alone produces NO wait row. A dependency-ready approved step can link to an already-established matching incident; never the reverse inference.

- **CAP-2 eligibility selection**
  - **intent:** The sensor can select, from waiting records, only still-approved unfinished work whose next permitted action can advance when that provider returns, with no cancellation, parked/manual hold, or other blocking condition on that action, and stop polling when none remain.
  - **success:** Deterministic tests show: cancel/park/manual-hold during a probe invalidates eligibility; completion/route change invalidates; zero eligible waiters stops the timer; an outstanding wait survives service restart (fake-clock) without re-baselining; a Silas logical-slot wait still schedules when the COO cannot take a model turn.

- **CAP-3 shared per-route checking**
  - **intent:** The scheduler can run one shared non-overlapping readiness check per exact provider/endpoint/model/credential binding, no more often than every 300 s (max 12 attempts/hour/route), with durable cadence/budget, bounded timeout, trustworthy Retry-After/reset scheduling, and bounded backoff — entirely in the service, independent of Silas's model availability.
  - **success:** Deterministic fake-clock tests with N>1 waiters on one exact route observe exactly one shared check per ≥300 s window (≤12/hour), zero per-waiter checks, no overlapping checks, backoff on probe failure, and correct next-check scheduling from a provider Retry-After. The scheduler keeps ticking while the Silas slot is stopped.

- **CAP-4 bounded same-route generation fallback probe**
  - **intent:** When no documented authenticated non-generation endpoint proves relevant access (none established for `zai-coding-cn`), the sensor can prove route access via a fixed short no-history/no-tools generation on the EXACT configured route/credential: max 64 output tokens, finite documented conservative timeout, no SDK/transport hidden retry expansion, failing closed on unsupported bounds.
  - **success:** Deterministic mock-provider tests assert the probe request carries maxTokens ≤ 64, no tools, no history (single minimal user message), retries = 0, and a finite timeout; unsupported probe envelopes (unknown model contract, missing bounds) fail closed (wait not cleared). No test performs a live provider call.

- **CAP-5 recovery evidence gate**
  - **intent:** The sensor can clear a wait only on fresh successful completed provider-protocol/producer evidence bound to the current incident and credential generation.
  - **success:** Deterministic tests show a completed protocol message (provider/model/usage present, terminal stop reason) clears the wait; literal "OK" text, shell-wrapper success, elapsed reset time, stale cached state, tool/transport failure, partial/unknown responses, and malformed evidence each fail to clear it.

- **CAP-6 durable recovery delivery**
  - **intent:** On valid recovery the service can persist a deduplicated recovery event and a pending delivery/claim, and wake Silas once through the existing durable event/digest mechanism, surviving restart and busy-trigger coalescing; if Silas itself is eligible-provider-stopped, deterministically re-arm only its same logical slot through guarded owned recovery or retain pending delivery.
  - **success:** Deterministic tests replay the recovery boundary: restart between event and delivery, wake while a Silas turn is open (coalescing), and recovery of the Silas slot itself — each yields exactly one eventual wake, no duplicate events, no second COO/Gru session, and no dependence on the stopped LLM to run the sensor.

- **CAP-7 guarded eligible-state transition**
  - **intent:** Silas can handle a recovery through a dedicated guarded eligible-state transition (not notification-ACK automation) that rechecks approval, current incident, step scope, other blockers, existing actor/tool cessation, and normal resident admission, starting one eligible continuation first and fanning out through the SAME resident budget only after actual model progress.
  - **success:** Deterministic tests show: admission recorded separately from event delivery; renewed quota during a recovered continuation returns the waiter to wait/backoff; bounded repeated false recoveries escalate to Gru (action-required) rather than looping; checkpoints preserved with no replayed committed side effects.

- **CAP-8 owner-control preservation**
  - **intent:** The sensor can leave auth/permission/billing/expired-plan/ambiguous failures and deliberate/historical owner stops under owner control, never blanket-converting `quota_wall`, and can clear only its own blocker.
  - **success:** Deterministic tests show 401/auth, billing/balance-permanent, and ambiguous failures produce NO automatic wait; the classifier distinguishes temporary quota/rate (429/1302/1308-class) from auth/billing; current ACKed historical incidents are not migrated; test failures, owner decisions, media safety, and review gates survive recovery; review-isolated Perkins attempts are never respawned by the generic path.

- **CAP-9 surface presentation**
  - **intent:** The service can show concise waiting-provider, last/next check, recovery-pending, and actually-resumed detail in existing job/attention surfaces.
  - **success:** Existing job/attention surfaces render the wait state without a board redesign; routine polling posts no recurring owner chime (no new needs-owner rows per probe cycle).

## Constraints

- Owner-approved policy pins (owner-approval.json): automatic recovery applies to NEW explicitly eligible temporary-provider waits only; probe cadence ≥300 s shared by exact route binding; max 64 output tokens; history=false; tools=false; hiddenRetries=false; provider v1 = the actual `zai-coding-cn` GLM coding route; no credentials/account changes; no historical owner-ack bypass; owner retains merge/deploy/restart; NO live provider probe or configuration change during development.
- Code ownership: the cap lane (worker-residency-budget) owns shared resident admission/quiescence/disposal; #69 owns worktree/target freezing; #130 owns App credentials/publishing. No editing other lanes, no vendoring their WIP, no second capacity counter, no bypassing normal registry admission. If edits require changing cap-owned behavior, stop at that seam and escalate.
- No live provider calls during development; tests use fake credentials/transports/homes; no ambient credentials or live keys in tests; reference scripts are never executed.
- Verification discipline: deterministic fake-clock/deferred/mock-provider tests for the full scenario matrix (gate-matrix.md); ALL broad or service-spawning verification goes through authenticated `/api/verify` with ≥36 GiB free and a real coordinated media/process-safe checkpoint through Silas requested first; every failed attempt preserved; no direct retries after failure, no tail/tee exit laundering, no timeout/pool weakening, no blaming CI for local failures.
- Gate discipline: fresh independent BMAD final-diff review is separate from exact-final-head CI and required native Perkins; the worker does not self-arm Perkins or force branch idle; no merge/deploy/restart/live config or auth changes/production provider probing; owner activation stays manual.

## Non-goals

- No blanket `quota_wall`-to-wait conversion; no migration of current ACKed historical incidents.
- No board redesign and no recurring owner chime for routine provider polling.
- No paid/general endpoint substitution, account/model switch, upgrade, or credit purchase.
- No background LLM watcher, OS daemon, or per-waiter agent; no second Gru/COO clone; no dependence on a stopped LLM to run the sensor.
- No live exhaustion testing, owner alarms, stress fixtures, or cross-lane process signals during development.

## Success signal

A deterministic fake-clock test drives the full loop — approved step hits a structured temporary quota rejection on the configured route → durable provider-wait → shared bounded same-route probe cadence → valid completed producer evidence → one deduplicated recovery event/delivery → one guarded Silas continuation that actually resumes the step with admission recorded — with no owner ACK anywhere in the chain, while auth/billing/ambiguous failures and historical ACKed incidents stay untouched by it.

## Assumptions

- The zai-coding-cn probe contract is verified from pi-ai source in this tree (baseUrl `https://open.bigmodel.cn/api/coding/paas/v4`, openai-completions API, env key `ZAI_CODING_CN_API_KEY`); runtime settings resolve the exact configured model per role through the same config path spawns use.
- Probe bounds: `maxTokens: 64`, `maxRetries: 0`, `maxRetryDelayMs: 0`, finite `timeoutMs` + AbortSignal, tools-free single-message Context — all directly supported by the pi-ai `ProviderRequestOptions`/`StreamOptions` surface in this dependency tree (verified in node_modules source).

## Open Questions

- None blocking implementation; the approved policy answered the probe-fallback decision. Genuinely new owner choices discovered mid-implementation escalate per the briefing.
