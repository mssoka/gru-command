---
title: 'gh-88: preserve judgment recency when deduplicating findings'
type: 'bugfix'
created: '2026-10-01'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '2aa836abe262759c651683deb40d05f02c9ede86'
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `dedupeVerifiedFindings` stores a merged finding's `roundOrigin`
as the oldest origin (`Math.min`) for display provenance, then compares
incoming duplicates against that stored value as if it were the retained
judgment's round. After a carried round-2 finding merges with a round-3
finding, the record reads `roundOrigin: 2` while its severity is the round-3
judgment; a second round-3 duplicate with the same normalized key then takes
the "newer round" branch against 2 and can silently downgrade the retained
judgment (round-3 blocker → round-3 warning). Static reproducible defect at
pinned head `2aa836abe262759c651683deb40d05f02c9ede86` (GitHub issue #88 /
Perkins R26); no observed production incident.

**Approach:** Determine judgment recency separately inside the dedupe fold:
each retained key tracks the actual round its retained judgment came from
(updated to the winner's round on every merge). Within the same actual round,
strictly higher severity wins; across genuinely different rounds the fresher
judgment wins (a newer-round lower severity may still downgrade an older
higher one — recency, not global max-severity). The stored `roundOrigin`
stays `Math.min` (oldest display provenance); the public `VerifiedFinding`
schema and all other dedupe behavior are unchanged.

Dispatch briefing `finding-dedupe-recency-88` (2026-10-01) settles this
intent and stands as the Checkpoint-1 approval.

## Boundaries & Constraints

**Always:**
- Preserve: normalized lowercase-title + location keying; sources union,
  deduped and sorted; deterministic output ordering (severity rank desc,
  then `location\0title`); same-round same-severity ties keep the earlier
  entry; inputs are never mutated.
- Preserve carried-finding semantics: still-present priors keep their
  original `roundOrigin`; optional refresh behavior is untouched.
- Every behavior change lands with a deterministic test that fails before
  the fix and passes after it.

**Never:**
- No new persisted or public field, no schema convention change, no
  migration; no reviewer policy/pin/resource change; no carried-finding
  refresh change; no publisher/auth/runtime/supervision change; no new
  dependency; no broad refactor.
- Do not edit `src/dispatch/perkins.ts`, `src/dispatch/perkins-review/whole.ts`,
  `test/perkins-whole-review.test.ts`, or `test/helpers/perkins-whole-double.ts`
  (PR135 lane owns settlement/review fixtures).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior |
|----------|--------------|---------------------------|
| Same-round duplicate after carried merge (order A) | carried r2 blocker, then r3 blocker, then r3 warning (same key) | retained r3 blocker; display `roundOrigin` 2 |
| Same-round duplicate after carried merge (order B) | carried r2 blocker, then r3 warning, then r3 blocker | retained r3 blocker; display `roundOrigin` 2 |
| Genuine newer-round downgrade | carried r2 blocker, then single r3 warning | retained r3 warning; display `roundOrigin` 2 |
| Repeated duplicates across rounds | r2 note, r3 blocker, r3 warning, r3 blocker, r4 warning | retained r4 warning; display `roundOrigin` 2 |
| Same-round tie | two r3 warnings, same key | earlier entry retained; sources union |
| Normalized key | `'Native  Settings Token'` + whitespace/case variants | merged into one entry |
| Distinct keys | 3 findings, mixed severities | stable severity-desc output order |

</frozen-after-approval>

## Code Map

- `src/dispatch/perkins-review/types.ts` — `VerifiedFinding` (oldest-origin
  display field), `normalize`, `dedupeVerifiedFindings` (~line 344 at
  `2aa836a`): the defect is `prior.roundOrigin === finding.roundOrigin` /
  `finding.roundOrigin > prior.roundOrigin` comparing the preserved display
  origin instead of the retained judgment's actual round.
- `src/dispatch/perkins-review/whole.ts:1405` — only caller:
  `dedupeVerifiedFindings([...carried, ...leadFindings])`; carried keep
  original `roundOrigin`, lead findings use the current `roundNumber`.
  Read-only for this fix.
- `test/perkins-findings-dedupe.test.ts` — NEW focused unit test; local
  fixture builder (no provider/host contact).
- `test/suite-shape.test.ts` — `PINS` map must gain the new file's static
  `it(` count.
- `.gru-command/worktree.toml` — declare the narrow `[verify]` scope.
- Keep green unchanged: `test/perkins-whole-review.test.ts` "still-present
  priors carry their original round marker and are not double-counted" and
  the refresh test (`roundOrigin` 1 with refreshed severity/location).

## Tasks & Acceptance

**Execution:**
- [x] `src/dispatch/perkins-review/types.ts` — track the retained
  judgment's actual round per key separately from the display
  `Math.min` origin; apply the within-round severity / across-round
  freshness rule against the tracked round; keep schema, keying, sources,
  ordering, ties and immutability identical otherwise.
- [x] `test/perkins-findings-dedupe.test.ts` — deterministic regressions
  covering every I/O-matrix row, including the order-dependent pair and the
  repeated multi-round sequence.
- [x] `test/suite-shape.test.ts` — pin the new test file's registered count.
- [x] `.gru-command/worktree.toml` — add the lane's focused scope entry.

**Acceptance Criteria:**
- Given carried round-2 blocker + round-3 blocker then round-3 warning
  (same normalized key), when deduped, then the round-3 blocker judgment is
  retained and display `roundOrigin` stays 2. This ordering must fail on the
  old code.
- Given the opposite order (round-3 warning then round-3 blocker), when
  deduped, then the round-3 blocker is retained (within-round severity rule).
- Given a genuinely newer round with lower severity versus an older higher
  severity, when deduped, then the newer judgment wins (no global
  max-severity collapse).
- Given same-round ties, normalized key variants, multi-source entries,
  distinct keys and repeated duplicates across rounds, when deduped, then
  the existing keying, tie, sources union/sort, output-order and
  no-input-mutation contracts hold.

## Implementation Notes

- 2026-10-01 red-first receipt: `npx vitest run test/perkins-findings-dedupe.test.ts`
  on unfixed `types.ts` (pinned baseline `2aa836a`) → exit 1, 2 failed |
  7 passed. Both failures are the defect: (1) carried r2 blocker + r3
  blocker + r3 warning retained `warning`; (2) the repeated multi-round
  sequence retained the r4 `note` over the r4 `warning`.
- Fix: `dedupeVerifiedFindings` now stores per key a `{finding,
  judgmentRound}` pair; the recency comparison uses `judgmentRound`
  (updated to the winner's actual round on every merge) while the retained
  `roundOrigin` stays `Math.min` for display provenance. No schema, caller,
  policy or fixture change; `whole.ts` untouched.
- Green receipt: same command after the fix → 9/9 passed. Focused scope
  (`test/perkins-findings-dedupe.test.ts test/suite-shape.test.ts`) → 11/11
  passed. `npm run lint`, `npm run typecheck`, `npm run build` (incl.
  Perkins resource verifier) all exit 0. Existing caller suites
  `test/perkins-whole-review.test.ts` + `test/perkins-builtin-wave.test.ts`
  → 155/155 passed.
- Review triage patches (2026-10-01): explicit `findingWins` boolean instead
  of reference-equality round advancement; local `RetainedFinding` type;
  two added preservation tests (repeated-source dedupe; empty/single-entry
  inputs). Re-run after patches: focused scope 13/13; lint/typecheck/build
  exit 0. The two defect-observing assertions are unchanged, so the red
  receipt still demonstrates the pre-fix failure.

## Review Triage Log

- Blind Hunter 1 (inline map shape unnamed) — `low` → patched: local
  `RetainedFinding` type names the finding/judgmentRound pair.
- Blind Hunter 2 (round advances via reference equality) — `low` →
  patched: explicit `findingWins` boolean now drives both the selection and
  the `judgmentRound` update.
- Blind Hunter 3 (repeated-source dedupe unpinned) — `low` → patched:
  added `dedupes repeated sources in the retained union and keeps them
  sorted`; removing `new Set` now fails an assertion.
- Blind Hunter 4 (empty/single input unobserved) — `low` → patched: added
  `returns empty and single-entry inputs unchanged`.
- Blind Hunter 5 (test helper overrides can replace asserted fields) —
  `low` — rejected: overrides are the helper's intended flexibility (used
  for title/location/sources/evidence); a guard would add complexity with
  no shipped behavior at risk.
- Blind Hunter 6 (rationale repeated across source/test/spec) — `low` —
  rejected: each note serves a distinct audience, and the test fails if the
  rule changes; no developer-visible harm.
- Edge Case Hunter — no findings (`[]`): branch/edge/deletion/claims walks
  clean on the diff (record: `review-gh-88-dedupe-recency.md`).
- Verification Gap Reviewer — `No verification gaps found.`: only caller is
  `whole.ts:1405` (symbol/import search), the new tests run in the default
  glob and are suite-shape pinned, and the red receipt would fail on a
  regression of the changed selection.

## Verification

**Commands:**
- `node tools/patch-vitest-rpc-timeout.mjs && npx vitest run test/perkins-findings-dedupe.test.ts` — red first (fails on unfixed `types.ts`, preserved receipt), then green after the fix.
- `node tools/patch-vitest-rpc-timeout.mjs && npx vitest run test/perkins-findings-dedupe.test.ts test/suite-shape.test.ts` — lane focused scope.
- `npm test` — full backend gate (lint, typecheck, build + resource verifier, vitest); web e2e/CI/Perkins gates via the scheduler.
