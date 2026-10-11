# GH-305 independent Herdr/BMAD review

Status: source complete. All original, parent-integration and supplementary findings are repaired; final independent readbacks are clean and full verification passed. Deployment and live twelve-ID readback remain owner-controlled. No deferrals or backlog entries.

Baseline: `f738b9b1594081cdbb4929af7be256454951eb43`.
Reviewed source snapshot: 45 files, +1580/-122 lines, 2947-line unified diff.

## Independent evidence

Every reviewer ran interactively in a fresh Herdr pane with read/search-only tools and model `openai-codex/gpt-6.1-sol`; the model-change record in each session confirms the provider and model. All four completed before triage. An edge-review status-wait window expired while it was still working; a subsequent blocking wait received its successful completion. No review layer failed.

Durable artifacts are retained in the parent session's review directory, bound by `manifest.json`. Machine-local absolute paths are not shipped.

- Blind Hunter: `wAE:p2G`; `blind-hunter.findings.md`.
- Edge Case Hunter: `wAE:p2H`; `edge-case-hunter.findings.md`.
- Verification Gap: `wAE:p2J`; `verification-gap.findings.md`.
- Acceptance Auditor: `wAE:p2K`; `acceptance-auditor.findings.md`.
- `manifest.json` binds panes, native sessions, model records and final findings.
- `review.diff` is the immutable input snapshot. `claims.md` was provided only to the edge reviewer.

## Individual verdicts, before grouping

Each row preserves a distinct finding and its verified bad outcome. Evidence references the reviewed source, before repair. Verification-gap coverage findings are accepted on the reviewer's documented test searches and mutation demonstrations. All other claims were checked against their implementations and callers by the parent. Nothing was rejected or marked unverified.

| ID | Lens | Verdict | Claim and evidence | Group |
| --- | --- | --- | --- | --- |
| B01 | blind | high | `service.ts:23` uses `>` while reconciliation sorts with `localeCompare`; mixed-case IDs can disappear between GET pages. | G01 |
| B02 | blind | high | `projection.ts:69` selects all role-minion rows by timestamp/id, unlike `listImplementerMinions`; reviewer/child rows can mask the real implementer's error, and timestamp ties use the wrong order. | G02 |
| B03 | blind | high | Projection-cache sequence guards miss existing `registerAgent` updates and directive-admission writes, which change source rows without appending events. | G03 |
| B04 | blind | high | `reconcileMailbox` reuses dispositions using basis equality alone; a cleared supporting decision remains attached and can suppress unresolved attention. | G04 |
| B05 | blind | high | Projection restrictions include holds/retired directives but never inspect `durableSupervisionStops`; an eligible stopped worker lacks its owner-stop restrictions and evidence references. | G05 |
| B06 | blind | medium | `receiptForKeys` re-looks up the current key and silently ignores a changed basis; a delivered historical item can be declared receipted without its evidence receipt. | G06 |
| B07 | blind | medium | `getAttentionRow` returns nonresolved rows even when already receipted; `admitWake` and pending pruning do not check receipt eligibility, so a queued wake survives passive delivery. | G07 |
| B08 | blind | high | Passive pages are bounded to `maxActionNotes`, while `advancePastRendered` stops at the first open oversized item; a full oversized prefix permanently hides its tail. | G08 |
| B09 | blind | high | Malformed PR/obligation evidence throws from projection; both WebSocket auth and debounced `pushSnapshot` invoke it without an exception boundary, allowing process termination. Strict evidence rejection itself is correct; the unhandled service exception is not. | G09 |
| B10 | blind | medium | Synthetic mailbox rows replace source kinds, but `recordEscalationTriageShadow` still filters those rows using `isSilasEscalationKind`; configured shadow asks stop. | G10 |
| B11 | blind | medium | Mailbox wake events exclude genuine source IDs from `notification_ids`; `telemetry/yield.ts` and `decisions/cases/escalation-triage-extract.ts` still join that field, losing causes and training linkage. | G11 |
| B12 | blind | medium | The mailbox branch in `onBusEvent` returns on machine notification closure before the existing cleanup branch; legacy follow-ups and failure/deferral bookkeeping remain open. | G12 |
| B13 | blind | high | Config and awareness permit intervals above Node's timer ceiling; direct `setInterval` clamps them to about 1 ms, creating a reconciliation storm. | G13 |
| B14 | blind | medium | The mailbox suite pin is 10, while the parent-added bounded-unhandled regression makes 11 tests; the normal exact-count gate fails. | G14 |
| E01 | edge | high | Awareness constructor admits timer-ceiling overflow and passes it directly to `setInterval`. | G13 |
| E02 | edge | high | Notification IDs are unrestricted, but `attentionRow` and rendering interpret any `mailbox:` prefix as synthetic; a genuine prefix-bearing row is lost or incorrectly JSON-parsed. | G15 |
| E03 | edge | medium | Passive `commit` records delivery without removing/revalidating the matching pending/active mailbox wake, causing an unnecessary trailing turn. | G07 |
| E04 | edge | medium | Wake-receipt retry records current recovery time rather than `batch.at`; recovery shifts the five-minute unhandled recheck instead of preserving delivery time. | G27 |
| E05 | edge | high | In passive-only mode, a full oversized page never advances its open prefix; smaller items past the page remain unreachable. | G08 |
| E06 | edge | medium | The event matcher recognizes `directive.` but not actual `silas.directive-*` events; changed control failures/retirements wait for the periodic sweep. | G16 |
| E07 | edge | medium | Startup/periodic woken-key cleanup calls only `wakePolicy.forget`; failure counts for stale mailbox incarnations persist indefinitely. | G17 |
| E08 | edge | high | Legacy machine notification seeds survive loading alongside synthetic equivalents; ordinary pending pruning does not enforce mailbox waiting/delegated eligibility for those original IDs. | G18 |
| E09 | edge | high | Newer review-bound minions can mask implementer errors because the canonical implementer query is not reused. | G02 |
| E10 | edge | high | GET cursor comparison and snapshot ordering differ for valid mixed-case IDs, skipping the tail. | G01 |
| E11 | edge | medium | Rendered mailbox identities/bases are not captured with delivery; changed current keys vanish from passive commit or parked recovery without a durable historical receipt. | G06 |
| E12 | edge | high | A cached snapshot can precede an eventless `recordDirectiveAdmission`; sequence-only reuse returns stale admission evidence. | G03 |
| E13 | edge | high | Cleared supporting decisions do not invalidate basis-equal dispositions; waiting/resolved suppression survives revoked authority. | G04 |
| E14 | edge | high | After bounded failed-turn retries post a needs-owner escalation, the new unhandled grace incarnation is admitted again; no gate carries the exhausted budget/owner stop across that incarnation. | G19 |
| E15 | edge | medium | Disposition validation checks future recheck time before detecting identical replay; an already-recorded waiting/delegated replay after expiry returns 400 instead of the unchanged truthful result. | G20 |
| E16 | edge | medium | The exact-count suite pin is stale after the eleventh mailbox test. | G14 |
| E17 | edge | high | `isMailboxView` coerces enums with `String(...)`; singleton arrays pass validation but fail strict kind/state handling downstream. Reference/disposition enums use the same coercion. | G21 |
| E18 | edge | medium | Synthetic source-kind replacement removes all Silas rows from escalation-triage shadow classification. | G10 |
| V01 | verification-gap | medium | Positive dirty-PR membership has no real-ledger regression; frontend tests manufacture membership and conflict-notification tests do not exercise valid branch-state evidence. | G22 |
| V02 | verification-gap | medium | No test rejects exact-basis partial reason coverage on resolution; changing `every` to `some` would silently pass existing cases. | G23 |
| V03 | verification-gap | medium | HTTP mailbox tests cover only 401/409/400 paths, not valid POST 200 and subsequent GET readback; success response regressions bypass those assertions. | G24 |
| V04 | verification-gap | high | GET cursor filtering uses binary comparison against locale-ordered snapshots, losing valid mixed-case items. | G01 |
| V05 | verification-gap | medium | A passive receipt leaves rate-deferred/active mailbox wakes eligible because neither lookup nor pending pruning checks receipt grace. | G07 |
| V06 | verification-gap | medium | Mailbox adapters replace the kind inspected by the existing escalation shadow classifier, disabling asks. | G10 |
| V07 | verification-gap | medium | The normal gate's pinned mailbox test count is 10 instead of 11. | G14 |
| A01 | acceptance | high | An already-surfaced obligation-only thread that moves to a future follow-up disappears from projection; the missing-source branch labels it resolved without settlement evidence. | G25 |
| A02 | acceptance | high | Basis-only disposition reuse preserves a cleared hold/resolution reference and suppresses attention after revocation. | G04 |
| A03 | acceptance | medium | Passive accepted-delivery receipt failures are only logged; unlike wake debt, they are neither parked nor retried, allowing another model prompt instead of metadata repair. | G26 |
| A04 | acceptance | high | Newer reviewer/child agents can hide primary implementer error discovery because the primary-worker query is not used. | G02 |
| A05 | acceptance | high | Passive rotation stops at an open oversized item and cannot progress through a full oversized prefix. | G08 |
| A06 | acceptance | high | GET pagination's binary filter disagrees with locale sorting and can omit valid identities. | G01 |
| A07 | acceptance | medium | The additional bounded-unhandled test invalidates the mailbox suite pin and therefore the required full gate. | G14 |

## Repair groups

All 27 groups route to patch: the approved intent determines the fix, no owner-controlled operational action is needed, and no new external capability is required. These are current-change repairs, not deferred work. Every patch needs a deterministic regression; existing authority boundaries and the frozen spec remain unchanged.

- [x] G01 — Use one ordering for snapshot, cursor and page traversal; verify mixed-case/punctuation IDs across all pages.
- [x] G02 — Use `listImplementerMinions` and its insertion-order tie-break; verify reviewer/child exclusion and primary error discovery.
- [x] G03 — Invalidate source projection on eventless source mutations, including admission/delivery/ownership writes and existing-agent updates; test cached-before-write scenarios.
- [x] G04 — Revalidate supporting disposition references and reopen revoked/ended support without granting authority; test cleared holds/resolutions and live delegation changes.
- [x] G05 — Carry durable supervision stops, owner restrictions and evidence references on independently eligible threads; owner-only stops still never widen FOR GRU.
- [x] G06 — Capture delivered identity, exact basis and attention incarnation before acceptance; durably record historical deliveries despite source changes, without suppressing new evidence.
- [x] G07 — Revalidate receipt eligibility at pending and final wake admission; passive delivery cancels redundant queued attention while explicit failed-turn retry remains possible.
- [x] G08 — Make passive overflow progression fair and durable; a full oversized prefix must not hide smaller tail work or receive false coverage receipts.
- [x] G09 — Contain malformed evidence at service/WebSocket boundaries with observable errors/unavailable state, never an uncaught process exception or fabricated clean mailbox.
- [x] G10 — Recover real source notifications for escalation-triage shadow classification and preserve its existing spend/readiness/mode gates.
- [x] G11 — Preserve explicit source-notification linkage in wake receipts for yield attribution and training extraction, while keeping mailbox and notification counts distinct.
- [x] G12 — Run closure cleanup before bypassing direct machine notification admission; retain legacy follow-up resolution and retry cleanup.
- [x] G13 — Reject unsupported timer intervals consistently at config/constructor boundaries or safely schedule long delays; verify the upper bound.
- [x] G14 — Refresh exact suite pins after all regression additions; preserve the suite-shape gate.
- [x] G15 — Distinguish synthetic delivery keys from genuine prefix-bearing notification IDs without dropping or misparsing real rows.
- [x] G16 — Coalesce actual directive/supervision source events through the existing mailbox reconciliation path.
- [x] G17 — Remove stale incarnation failure bookkeeping when source/key debt ceases, without resetting active bounded retries.
- [x] G18 — Normalize legacy machine pending seeds into canonical mailbox eligibility on startup; waiting/delegated work must not regain a duplicate legacy wake.
- [x] G19 — Preserve exhausted failed-turn retry/owner-escalation suppression across unchanged-basis unhandled rechecks; attention never rearms an owner stop automatically.
- [x] G20 — Replay identical dispositions idempotently after expiry without renewing their deadline or accepting a new stale write.
- [x] G21 — Require actual strings for all mailbox enum fields; reject coerced array/object values at runtime validation.
- [x] G22 — Add a real-ledger positive dirty-PR projection test using authentic branch-state payload, without action-required notifications.
- [x] G23 — Add multi-reason partial-resolution rejection, checking state and event watermark remain unchanged.
- [x] G24 — Add valid authenticated disposition POST and GET readback coverage at the HTTP boundary.
- [x] G25 — Preserve previously surfaced live obligation follow-ups as waiting/delegated with actual dependency/owner/recheck; do not infer resolution from temporary absence of due attention.
- [x] G26 — Park and recover passive accepted-delivery receipt debt durably, without duplicating a model turn or modifying operational rows.
- [x] G27 — Preserve original delivery time in receipt retries/restart recovery; do not postpone the unhandled attention bound.

## Parent integration corrections

All were reproduced or traced at the component handoff barrier and repaired without changing the frozen intent:

| ID | Verdict | Verified bad outcome and correction | Group |
| --- | --- | --- | --- |
| P01 | medium | Optional `sourceObligationId` accepted arbitrary wire values; actual nonblank strings are now required, with snapshot/frame regressions. | G21/G25 |
| P02 | high | Legacy `receiptForKeys` could receipt a synthetic item using a colliding genuine ID; ambiguous bare keys now prefer the genuine domain, while explicit branded captures remain receiptable. | G06/G15 |
| P03 | high | Correlated streaming work could replace a retained permission debt's actual owner with a minion; delegation now requires that work's owner to match the actual next-action owner. | G25 |
| P04 | medium | Source-derived non-Gru monitoring swallowed an attached applicable explicit Gru decision recheck; real recorded follow-up now restores attention when due, without operational mutations. | G25 |
| P05 | medium | Source failure retained unlabeled old counts and `auth_ok` advertised open before fresh data; nonfatal errors/HTTP failures now surface unavailable/last-known state, preserving pairing and disclosure state until a real snapshot. | G09 |
| P06 | medium | New parameterized backend tests violated the static-registration guard; explicit cases now retain every assertion and exact pins rather than weakening the guard. | G14 |
| P07 | medium | Node SQLite truncates NUL-bearing notification identities; a named transactional-boundary rejection now prevents partial or empty identities before any write. Ordinary prefix-bearing IDs remain supported. | G15 |
| P08 | high | The stricter PR validator broke a real pre-open-status legacy snapshot. Initial legacy observations remain readable/unknown, without admitting PR attention or owner-ready actions. Once a conflict surfaced, missing/unknown/wrong-pull observations cannot infer closure; genuine same-pull closed observations still can. | G09/G22 |

Durable assertion-red/green logs are in the independent artifact directory: `parent-integration-backend-red.log`, `parent-integration-web-red.log`, `parent-presentation-red.log`, `parent-identity-red.log`, `parent-owner-assertion-red.log`, `parent-integration-final-green.log`, `parent-integration-web-green.log` and `parent-registration-green.log`. Initial fixture-only failures were corrected before the valid assertion-red captures. The parent preserved the original staged index digest and made no commit, push or live-state change.

## Supplementary integration review

The fresh read-only integration reviewer reported four remaining defects. Each was independently reproduced before repair; every finding routes to patch, without deferral.

| ID | Verdict | Verified bad outcome and correction | Group |
| --- | --- | --- | --- |
| F01 | high | An exhausted-only accepted batch persisted count 2, not 3, until another sweep; every classified failure count now persists before retry/escalation, with immediate-restart and grace-expiry assertions. | G19 |
| F02 | high | Fresh-source pruning/claim lookup could throw before accepted captures were parked; immutable captures now supply dedupe identities and are durably parked before source reads, with live retry/restart and original-time assertions. Source unavailability remains explicitly logged. | G06/G26/G27 |
| F03 | high | Object-shaped malformed PR values could remove the sole reason and infer resolution; canonical eligibility-field types now fail loudly before projection/reconciliation. Persisted attention remains unchanged; HTTP 503 and nonfatal WS 1011 recover with the same token. | G09/G22 |
| F04 | medium | Internal NUL attention domains entered blocked-wake notification IDs/kinds/detail; mailbox notices now use a disjoint writable identity and the actual delivery key, preserving legacy genuine-notification notice identities and idempotent chat notices. | G15 |

Evidence: `follow-up-assertion-red.log` proves all four original failures; `follow-up-boundary-red.log` proves malformed-object HTTP/WS gaps. `follow-up-verified.log` reports 191 passing mailbox/awareness/server/suite-shape tests, plus clean typecheck, lint, hygiene and staged/unstaged diff checks. An intermediate green run exposed a fixture assertion about omitted empty optional sidecar metadata; the assertion was corrected to the actual serialization contract, without weakening delivery/time guarantees.

The same-role follow-up independently traced all F01–F04 repairs, chat acceptance/recovery callers, receipt recovery, admission and web presentation, and returned **no actionable findings**. The next full suite exposed P08 in the existing legacy FOR YOU regression; additional legacy/unknown/wrong-pull assertion-red cases were captured in `legacy-pr-assertion-red.log` and `stale-pr-assertion-red.log`. The corrected source passed 237 targeted tests plus typecheck/lint/hygiene/diff checks (`legacy-pr-verified.log`). The final independent compatibility readback is clean: legacy unknown-open observations remain readable/noneligible, while missing/unknown/wrong-pull evidence cannot clear surfaced conflicts and explicit same-pull closed evidence remains supported. Complete findings are retained in `compatibility-review.findings.md` with the parent-session artifacts.

## Rejected

None.

## Verification and operational boundaries

Worker-reported pre-audit gates were 4560 passing assertions, 17 skips, successful web build and 84 browser tests. Those receipts do not verify the current source. The parent first confirmed and repaired a stale mailbox pin (registered 11 versus pin 10; `suite-shape-confirmed-red.log`). The first post-repair full-gate attempt passed lint/typecheck/build and 2980 fast backend tests, then failed only the heavy hygiene regression: this report exposed a machine-local personal artifact path. That path has been removed without weakening the hygiene gate. Supplementary fixes and new regressions changed source again. Final unchanged-source verification passed in `final-verification-pass3/`: `npm test` (2990 fast backend + 1024 heavy backend + 629 web = **4643 passed**, **17 skipped**), `npm run build:web`, and `npm run e2e` (**84/84 passed**). Complete logs, zero exit receipts and matching 778-entry source manifests are retained with the parent-session artifacts. The parent repair manifest binds the final completion-artifact verification receipt.

No commit or push was created; the pre-existing staged index remains unchanged. No deployment, service restart, merge, live acknowledgement, owner-stop rearm, GC dispatch or installed-ledger mutation occurred. The historical twelve-ID rollout readback remains owner-controlled; this report does not manufacture live receipts.
