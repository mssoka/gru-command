# PR #136 — routine completion-loop CI repair

The continuation repairs the two failures evidenced by CI run **36683456743**
on candidate `51aa1ec48f9ef2d69a30ccd0adb17b343958e2fb` (default merge result
`6c11cce026dc6f76ecac50ab4564b7c9774af2a4`). It does not expand the released
product slice or change runtime safety policy. All prior receipts/logs
remain byte-for-byte unchanged. This minion did not ACK, disposition,
modify or reopen escalation `9bb7dfaa-fdfb-475c-8449-b890ab47e366`.
A read-only check observed a separate native `notification.resolved`
event (seq 30552, 07:51:14Z) ratifying the continuation; that observation
is recorded separately, never back-written into the historical receipts.
The event's `by` claim does not prove caller identity under shared auth.

## Diagnosis and repair

### Full-suite registration pins

`test/suite-shape.test.ts:126` failed file-name equality before its per-file
pin checks. `owner-actions.test.ts` was missing from PINS. The preserved
CI log reports **28 cases** at line 849, but that source had only eight
explicit registration sites: its 21 negative-readiness cases were emitted
from one loop. Merely pinning eight would not retain the full-case guarantee;
pinning 28 without expanding the loop would still fail the static guard.

- Register the same 21 cases explicitly, retaining every name, input and
  null-readiness assertion. With the seven other cases, the file now has
  28 explicit registrations; pin **28**.
- Correct the inherited `github-poll.test.ts` pin **22 → 24**: source and
  the preserved CI result both show 24. The old file-name failure hid this
  later comparison.
- Keep the guard's file-set equality, registration matching, parameterized
  case prohibition and assertions unchanged. A source-only inventory of
  all 100 files finds no remaining missing pin or registration-site mismatch.
  This inventory is not runtime collection or a test pass; existing shared
  helper registrations retain their existing source-site pins.

### Breaker fixture lifecycle, not a policy exception

`test/supervisor.test.ts:1132` read an undefined alert after `sleep(50)`.
The fixture calls one watchdog tick; it does not start the periodic ticker.
Source lifecycle:

1. `tick()` detects the hung open turn and calls `evaluateRecovery()`.
2. With no decision service, `restartRungInner()` records attempt 1,
   disposes the first handle, then awaits the rejecting spawn factory.
3. Each failed rung schedules a **new** backoff after its async work:
   1, 2 and 4 ms for the fixture's unchanged limits (maxRestarts 3,
   restartBackoffMs 1).
4. The callback after the third failure enters the next rung's guard,
   which calls `tripBreaker()`. Only there is the needs-owner alert posted.

An independently scheduled 50 ms sleep is not a receipt for that chain:
it can become due before a later, newly scheduled backoff runs. The CI log
does not include a timer trace, so no environment-only root-cause claim or
passing baseline is asserted. The source defect repaired here is relying
on elapsed wall time instead of driving the required fixture lifecycle.

Use test-local fake timers, flush the first failed spawn's microtasks, then
advance **exactly three** next timers. Assert the bounded spawn counts,
one pending timer before each step and no pending timer at the breaker.
Retain all original assertions (alert exists, replacement refused, fresh
handle disposed, ACK remains null, slot empty, breaker open/stopped with
three restarts); additionally assert needs-owner routing, one alert and no
extra spawn. Always dispose the harness and restore real timers in finally.
No production supervisor code, sleeps, timeouts, pools or restart limits
were changed. Timer APIs match the installed Vitest declarations and the
repository's existing asynchronous fake-clock conventions.

## Given / When / Then

- **Given** all retained owner-readiness scenarios and the inherited poll
  cases, **when** the unchanged full-suite guard scans registration sites,
  **then** file equality includes owner-actions and pins are 28 / 24.
- **Given** a hung slot and a spawn factory that always rejects, **when**
  the fixture drives its first async failure and three scheduled backoffs,
  **then** three restart attempts lead to exactly one unacknowledged owner
  breaker; intentional replacement remains refused and no fourth spawn
  attempt is admitted.

## Gate matrix at source settlement

| Gate | Evidence / state |
|---|---|
| Historical CI | FAILED: lint/typecheck/build passed; backend 2 failed, 1493 passed, 9 skipped; web not reached. Preserved, not replaced by this diagnosis. |
| Source inspection | 100 files inventoried; guard implementation unchanged; no pin mismatches; `git diff --check` passes. Not execution proof. |
| Full local verification | Owed to Silas scheduling: FULL `/api/verify` only, real media/process-safe checkpoint and >=36 GiB free, complete capture opened before request and nested `outcome.exitCode`. No local substitute run. |
| Fresh exact-head CI | Required after the normal, non-force push of the settled repair commit. |
| Independent final-diff review | Owed; author inspection is not independent. No initial BMAD rerun or trust-failure workaround. |
| Native Perkins | Owed on the final head after source/push settle under freeze-r1; old r3 on `a73aee3` is not clearance. Minion does not arm review. |

Silas receives verification readiness naming the final pushed SHA and this
diagnosis. Freeze source/head thereafter; reconcile actual run/receipt
state before any further action. Failed outputs remain failed. Owner alone
controls merge, deployment and restart.
