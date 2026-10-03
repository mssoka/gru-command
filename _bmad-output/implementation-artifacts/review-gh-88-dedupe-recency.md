# gh-88 review record — finding dedupe judgment recency

- Date: 2026-10-01
- Lane: `gru/finding-dedupe-recency-88`, baseline `2aa836abe262759c651683deb40d05f02c9ede86`
- Method: the three bmad-build review layers ran inline in this session (no
  subagent runtime is available here; same model as the session), following
  the gh-97 precedent. Raw layer outputs below; triage lives in the lane
  spec's `## Review Triage Log`.

## Review content

Unified diff of all changes since the baseline (untracked included),
17,983 bytes at review time: `src/dispatch/perkins-review/types.ts`,
`test/perkins-findings-dedupe.test.ts`, `test/suite-shape.test.ts`,
`.gru-command/worktree.toml`, and the lane spec.

## Blind Hunter

Arithmetic: diff is 17.56 kB; N = min(floor(sqrt(17.56) + 1), 10) =
min(floor(5.19), 10) = 5.

Findings (no severity/ranking, as directed):

1. The retained map value shape `{ finding, judgmentRound }` is declared
   inline at the `Map` generic; naming the local type would document that
   the round belongs to that specific retained finding.
2. `judgmentRound` advances via reference equality (`preferred === finding`);
   any later edit that copies `preferred` before storing would silently stop
   advancing the round instead of failing. An explicit winner boolean makes
   the coupling structural.
3. Repeated-source dedupe in the sources union is unpinned: every test uses
   disjoint source sets, so removing `new Set` would not fail an assertion,
   although the spec's preserved contract says sources are deduped.
4. No test covers empty input or a single entry; both bypass the comparison
   logic, so a regression there (wrapping/dropping entries) would be
   invisible.
5. The test helper spreads `...overrides` last, so a case can accidentally
   override the field it means to hold fixed (e.g. `roundOrigin`), with no
   guard beyond the type.
6. The rationale "oldest origin is display provenance, not judgment recency"
   now appears in the source comment, the test comment, and the spec; the
   repetition invites drift if the rule changes.

## Edge Case Hunter

Method note (steps run in order): Step 2 walked the changed function's
branches — `byKey.get` miss vs hit; same-actual-round vs different-round;
strictly-greater severity vs tie; winner-is-incoming vs winner-is-retained;
`Math.min` display write; union/Set/sort; output map/sort. All three
severity members of the fixed set remain covered by the rank table; both
new branches (`judgmentRound === roundOrigin`, `>`) have explicit handling;
the call site `dedupeVerifiedFindings([...carried, ...leadFindings])`
matches the unchanged signature. Step 3 re-walked the edge classes
(undefined map hits, ties, NaN/unreachable fractional rounds, single/empty
inputs) — no unhandled reachable path found. Step 4 deletion check: the
removed comparison/storage was replaced in full (keying, severity rank,
union/sort, min-origin display, output sort all re-established; no orphaned
reference or dead code). Step 5 claims check against the spec Intent and
Tasks & Acceptance: all checkable claims (tracked judgment round, strict
same-round severity, fresher-round recency, `Math.min` display origin,
schema/keying/sources/ordering/immutability preservation) verified in the
code and tests; none falsified.

Raw output:

```json
[]
```

## Verification Gap Reviewer

Method note: screened the diff (behavioral: the selection semantics in
`dedupeVerifiedFindings`; non-behavioral: comments, spec/test-adjacent
wording). Traced the changed behavior to its only consumer, the terminal
submission at `src/dispatch/perkins-review/whole.ts:1405`, and read the new
tests and the existing caller suites. Symbol search (`dedupeVerifiedFindings`,
import references) shows the one caller only — no un-adopted sibling site.
The new regression tests run in the default vitest glob, are pinned in
`test/suite-shape.test.ts`, and fail on the pre-fix code (red receipt); the
existing caller suites `test/perkins-whole-review.test.ts` +
`test/perkins-builtin-wave.test.ts` (155 tests) pass unchanged. No
regression, broken-verification, or missing-adoption gap was found.

Raw output:

`No verification gaps found.`
