# Code map — provider recovery sensor (lane-local audit, 2026-09-28)

Audited at branch base `128412db65f25183854b5d3b54768f51aa8bd862` merged with
origin/main `df9fe01e87913c5f2ad47219ddc2f838eca6d045` (fast-forward merge in
this lane; remote default verified `main`).

## Integration seams (real paths)

| Seam | Path | Role for the sensor |
| --- | --- | --- |
| Failure classifier | `src/decisions/questions.ts` (`deterministicFailureClass`, `FAILURE_CLASSES`) | Deterministic text classifier; `quota_wall` deliberately MIXES 402/403/429/balance/quota — the sensor needs its own provider-aware classifier over structured evidence, never this blanket class |
| Supervisor | `src/supervision/supervisor.ts` (`evaluateRecovery`, `stopForGuidance`, `onNotificationAcked`, `SupervisedSlot`) | Where runtime provider errors stop an agent: breaker opens, `supervision.provider-wall.<agentId>.<class>` needs-owner incident (dedupe unacked) posted, handle disposed. Ack re-arm is human-only. Recovery must use a separate guarded transition, never an ack spoof. |
| Silas driver | `src/dispatch/silas-driver.ts` (`SilasDriver.trigger`, `computeSilasDigest`, `SILAS_WAKE_EVENTS`, wake kinds) | Durable event wakes with latest-wins coalescing; digest computed from ledger; wake prompt carries skills. Wake kinds today: `job.delivered`, `job.minion-error`, `round.verdict`, `round.perkins-incomplete`, `sweep`. The provider-restored trigger rides this mechanism. |
| Ledger | `src/ledger/db.ts` (MIGRATIONS 1–8), `src/ledger/api.ts`, `src/ledger/states.ts` | Forward-only contiguous migrations; `pending_rebriefs` (id 8) is the restart-safe marker precedent. New migration id 9 for provider waits + pending recovery delivery. Job states: dispatched/working/delivered/in-review/blocked/parked/merged/done (blocked & parked = recoverable side-states; merged/done terminal). |
| Runtime adapters | `src/runtime/pi-adapter.ts`, `src/runtime/registry.ts`, `src/runtime/types.ts` | pi adapter emits in-band provider errors as `{type:'error', error: detail, fatal:false}` (message_end stopReason error) and sets state 'error'; registry tap fans envelopes to supervisor/board. Model resolution: `resolveModel`/`resolveSettingsDefault` via `ModelRuntime` (offline catalog + bounded refresh), config `[models]`/`[runtimes]`/pi settings.json. |
| Model/probe transport | `@earendil-works/pi-ai` (in node_modules, verified from source) | `ModelRuntime.complete/completeSimple(model, context, options)`: `Context = {messages:[user], no tools}`; `StreamOptions.maxTokens`; `ProviderRequestOptions.timeoutMs`, `maxRetries` (SDK default 2 — MUST pass 0), `maxRetryDelayMs`, `signal`. Provider errors carry `status`+`headers` (retry-after / retry-after-ms readable). Completed evidence = `AssistantMessage` with `stopReason 'stop'|'length'`, `usage`, `provider`, `model`, optional `responseId`. |
| zai-coding-cn provider | pi-ai `providers/zai-coding-cn.js` + `data/zai-coding-cn.json` | baseUrl `https://open.bigmodel.cn/api/coding/paas/v4`, openai-completions API, env auth `ZAI_CODING_CN_API_KEY`. This is the installed China coding route (pi settings defaultProvider). |
| Config | `src/config.ts` (`SilasConfig`/`DEFAULT_SILAS_CONFIG` pattern, `GruCommandConfig`), `src/config-reference.ts`, `docs/CONFIG.md` | New `[provider_recovery]` section follows the SilasConfig pattern (enabled, cadence, budgets); reference/docs updated in the same change. |
| Board/job surfaces | `src/board/engine.ts`, `src/dispatch/silas-driver.ts` digest rows | Concise wait fields ride existing job rows/attention feed; no board redesign. |
| Restart-safe recovery precedent | `src/dispatch/rebrief-recovery.ts` | Durable marker + guarded event + boot reconciliation + `activeClaims` single-flight; escalation pattern for failed recovery. The sensor's pending-delivery/claim follows this shape. |
| Notification center | `src/notifications/center.ts`, ledger notifications API | `postIncident(dedupe:'unacked'|'active'|'all')`; `isOwnerHeldNotificationKind` pins `supervision.provider-wall.*` owner-held; `disposeMachineNotification` rejects non-action-required. Confirms: no ack spoofing path exists; recovery uses its own transition. |

## Shared-hook integration map (before touching supervisor/registry/main/config seams)

1. **supervisor.ts** — minimal hook: when `evaluateRecovery`/`stopForGuidance`
   classifies a provider wall, it notifies the provider-recovery recorder with
   the structured failure context (agent, role, slot, sessionFile, error
   evidence). The supervisor keeps ALL of its existing stop semantics
   (breaker, incident, disposal); the sensor only observes and persists
   eligible waits. No change to `onNotificationAcked` semantics.
2. **silas-driver.ts** — add `provider.restored` wake kind + digest row fed
   from the ledger events the sensor appends; wake prompt gains a short
   recovery-handling paragraph (operating skill text rides the existing
   skills directory). Coalescing/one-slot queue unchanged.
3. **main.ts** — construct/start the scheduler after SilasDriver (service
   timer, `unref`), stop it in shutdown alongside silas. No new port, no new
   process.
4. **ledger** — migration 9 (`provider_waits` + `pending_provider_recovery`);
   API additions scoped to the sensor module; events ride the existing
   append-only events table.
5. **config.ts / config-reference.ts / docs** — new `[provider_recovery]`
   section, defaults matching the owner-approved policy (300s cadence, 12/hr,
   64 tokens, timeouts).
6. **registry/resident admission** — NO CHANGES (cap-owned seam). Recovery
   continuation goes through the existing silas slot / dispatch surfaces only.

## Cap-lane boundary (do not cross)

Cap (`worker-residency-budget`, snapshot 4f04224, unmerged) owns resident
admission/quiescence/disposal. If the sensor's continuation flow needs
resident-budget behavior that does not exist on current main, stop at that
seam and escalate; the sensor plans against CURRENT MAIN's existing silas
slot + dispatch + supervisor mechanisms only.

## Not provider quota readiness

Context-window usage telemetry (`getContextUsage` in runtime types,
chat/server.ts surfaces) is NOT provider quota readiness. Never wire it into
the sensor.

## Final implementation map — r1 blockers + owner multi-provider overlay (2026-09-29)

The audit above is the pre-implementation map; the shipped surface after the
r1 Perkins rework and the owner-approved multi-provider extension is:

| Area | Path | Content |
| --- | --- | --- |
| Classifier | `src/provider-recovery/classify.ts` | Typed-evidence-only classification; owner statuses (401/402/403) beat quota-flavored body codes; supported providers: `zai-coding-cn` (generation fallback, activation-gated), `openai-codex` + `anthropic-claude-native` (metadata-only). |
| Metadata adapters | `src/provider-recovery/metadata.ts` | Codex `wham/usage` + Claude `oauth/usage` read-only adapters; strict schema validators; 401/403/402 → owner-controlled; 429/transport → read failure; optional model windows = unknown, never unlimited; ZERO generation; single bounded GET with credential-claim request binding (`ChatGPT-Account-Id`). |
| Metadata composition | `src/provider-recovery/composition.ts` | Nonmutating codex snapshot via `readStoredCredential` (no refresh, ms-expiry verified from pi-ai source); claude snapshot from the observed keychain item (`claudeAiOauth`, pro/max only) behind an injected command port; `BoundMetadataReader` fences provider + credential-generation fingerprint; safe-category logging only. |
| Probe (GLM) | `src/provider-recovery/probe.ts` | Exact endpoint + credential binding verified at probe time; `maxTokens 64`, `maxRetries 0`, `maxRetryDelayMs 0`, finite timeout + AbortSignal; completed-producer evidence gate. |
| Sensor | `src/provider-recovery/sensor.ts` | Explicit typed establishment; eligibility with durable establishment-status vs churn; ≥300 s floor on every outcome; reserve-and-charge before I/O (crash → spent-unknown); post-I/O reload/revalidation; atomic shared recovery batch; single durable delivery path (`provider.restored`); lineage-based renewal ladder; deterministic in-service timer. |
| Resume/claim | `src/provider-recovery/resume.ts` | Atomic claim-before-spawn; full recheck set; one continuation; admission recorded separately; silas-slot guarded re-arm with tolerant concurrent settle. |
| Admission ports | `src/provider-recovery/admission-observations.ts` | Typed admission/progress observations + all-binding fan-out gate. SOURCE-ONLY consumer: the cap-owned runtime emitter is NOT grounded on this branch (returned as the precise interface; no cap files touched). |
| Ledger | `src/ledger/db.ts` migration 9 (unshipped, edited in place), `src/ledger/api.ts` | `provider_waits` (+endpoint/job-status-at-establishment/lineage/batch), `provider_routes`, `pending_provider_recovery`, `provider_probe_reservations`; atomic batch + CAS claim APIs. |
| Supervisor seam | `src/supervision/supervisor.ts` | `ownsProviderWall` (machine ownership BEFORE any owner stop) + `linkProviderWaitIncident`; typed evidence threading; guarded `ownedProviderReArm`; stop/ack semantics otherwise unchanged. |
| Notification seam | `src/notifications/center.ts`, `src/ledger/api.ts` | `supervision.provider-wall.*` no longer force-held: the supervisor's explicit routing governs (action-required = machine-owned; needs-owner = conservative fallback). Other owner-held kinds unchanged. |
| Runtime seam | `src/runtime/{types,pi-adapter}.ts` | `typed` provenance on error events — sdk-error (numeric status + headers) or provider-message (strict machine-composed line) only. |
| Wiring | `src/main.ts` | Sensor before supervisor (late-bound wake/re-arm); `ownsProviderWall`/`linkProviderWaitIncident` wired; claude context observes env + settings-file overrides (no brand assertion); metadata readers composed from read-only installed source interfaces. |
| Config/docs | `src/config.ts`, `src/config-reference.ts`, `docs/CONFIG.md`, `docs/example.config.toml` | `[provider_recovery]` incl. `probe_timeout_ms` and `glm_generation_fallback` (default OFF = fail closed, zero I/O); approval floors enforced at parse time. |
