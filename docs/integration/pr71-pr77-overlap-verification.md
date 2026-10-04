# PR71 × PR77 overlap verification (issue #128)

The independent PR71 review pinned ten files as the #71/#77 integration
overlap. This record is the verification of that integration event: which
files needed edits, which passed as-is, and the evidence for both. It is a
verification record, not a repair ticket — the individual #71 defects are
their own issues.

## Verdict

- Exactly **one** of the ten files needed integration edits:
  `test/suite-shape.test.ts` (the single content conflict; its PINS table
  was regenerated from the actual merged tree).
- The other **nine auto-merged untouched**: every line added by each side
  (relative to the shared base `128412db`) is present verbatim in the
  integrated tree.
- `test/suite-shape.test.ts` passes on the current tree, so the pins equal
  the actual registered-test union.
- The board snapshot/classifier chain agrees across engine, web protocol,
  signals and UI — including the terminal-job set, which has a dedicated
  cross-build drift alarm.
- The guarded clean-abort tests re-run green against the post-#77 runtime.
- The full suite was green on the integration merge, the PR77 head and the
  merge into main (exact-head GitHub CI), and remains green on current main;
  focused suites re-ran green locally on current main.

## Refs

| Role | SHA |
|---|---|
| Shared base both PRs were built on | `128412db65f25183854b5d3b54768f51aa8bd862` |
| #71 merged to main (review head `387b457` is an ancestor) | `6249e98a40fb022348210ef8dd5ce794e32c9e57` |
| #77 pre-integration branch head | `25405387fb319c1bbbda5f92fb7ff44238282e5a` |
| Integration merge on the PR77 branch | `234b1e9814819a8a8129efa75b1e7c6b9e552ede` |
| Final PR77 head (checked into main) | `5da02249b36161905cab61559e7eaa539e3f4d77` |
| PR #77 merge commit on main (2026-09-27) | `4845b1a42e4a77e6b3d8daf7d8621f49e8ac1188` |
| Current main at focused re-verification | `6190487` (PR #196 merge) |

## Method

1. **Conflict surface.** `git merge-tree --write-tree 2540538 6249e98`
   reports exactly one `CONFLICT (content)` — `test/suite-shape.test.ts` —
   and `Auto-merging` for the other nine files.
2. **Added-line union.** For each auto-merged file, every line added by the
   #71 side (`git diff -U0 128412db 6249e98`) and by the #77 side
   (`git diff -U0 128412db 2540538`) was checked for an exact full-line
   match in the integrated tree `5da02249`. All present, both sides.
3. **Pins.** `suite-shape` regenerates `PINS` from the actual `test/`
   listing and compares every file's registered `it(` count; it passes.
4. **Board chain.** Read engine snapshot fields, the web protocol
   validator, the signal derivations and the UI consumers; run their
   suites. The terminal set carries a cross-build alarm that reads
   `src/ledger/states.ts` directly.
5. **Clean-abort.** Run `test/dispatch-server.test.ts` (heavy config) on
   the current tree — the guarded same-head re-arm test runs against the
   post-#77 WaveRunner.
6. **Full suite.** GitHub CI check runs at the exact integration SHAs.

## Per-file record

| File | #71 / #77 added lines | Merged as-is | Edits needed |
|---|---|---|---|
| `src/board/engine.ts` | 28 / 9 | yes | none |
| `test/board-engine.test.ts` | 49 / 37 | yes | none |
| `test/dispatch-e2e.test.ts` | 4 / 4 | yes | none |
| `test/dispatch-server.test.ts` | 41 / 4 | yes | none |
| `test/roles-definitions.test.ts` | 3 / 6 | yes | none |
| `test/suite-shape.test.ts` | conflict | resolved | **PINS union regenerated** |
| `web/src/lib/board-signals.test.ts` | 6 / 51 | yes | none |
| `web/src/lib/board-signals.ts` | 2 / 30 | yes | none |
| `web/src/ui/board.test.ts` | 90 / 61 | yes | none |
| `web/src/ui/board.ts` | 114 / 16 | yes | none |

Both sides kept: #71 pending/wake snapshot fields, pagination and
owner/machine split; #77 whole-PR lens classification (`used`/`unused`/
`ran`, settled progress) and the review runtime. Nothing from either side
was dropped to make the merge.

## Board snapshot / classifier agreement

- **Engine** (`src/board/engine.ts`): `BoardSnapshot` carries
  `unackedActionRequired` (NEEDS GRU live machine queue),
  `unackedNeedsOwner` (FOR YOU bell class) and `wakes`; notifications
  paginate both pending routings and keep the receipt window; routing is
  `'fyi' | 'action-required' | 'needs-owner'`.
- **Protocol** (`web/src/lib/board-protocol.ts`): mirrors the routing
  union and both counters plus `wakes` and rejects malformed snapshots, so
  a shape drift fails the client loudly.
- **Signals** (`web/src/lib/board-signals.ts`): `unackedByJob` counts
  unacked machine rows bound to non-terminal jobs;
  `terminalBoundNotificationIds` classifies terminal-bound rows as closed
  receipts; `roundSummary` derives `used`/`unused`/`ran`/settled; 
  `jobSignal` orders attention before liveness and returns null for
  concluded jobs.
- **UI** (`web/src/ui/board.ts`): NEEDS GRU renders the live machine queue
  and never rings the bell; the bell badge and toasts ride needs-owner
  rows only; concluded rows cannot re-enter NEEDS GRU.
- **Terminal-set agreement:** the ledger's `JOB_TERMINAL` is
  `{merged, done}` and the web's `isJobConcluded` is `{merged, done}`;
  `web/src/lib/board-signals.test.ts` reads `src/ledger/states.ts` and
  fails if the two ever drift.

## Verification runs (current main `6190487`)

- backend fast: `test/board-engine.test.ts` (35), `test/roles-definitions.test.ts` (10),
  `test/suite-shape.test.ts` (2) — 47 passed.
- backend heavy: `test/dispatch-e2e.test.ts`, `test/dispatch-server.test.ts` —
  44 passed, including *"re-arms one proven same-head service-restart abort
  through the guarded Silas review API"*.
- web: `board-protocol` (14), `board-bands` (33), `board-health` (13),
  `board-signals` (21), `board` UI (62) — 143 passed.

## Full-suite evidence (GitHub CI `Full suite (Node 22)`, all `success`)

- `234b1e9` — the integration merge.
- `5da02249` — the PR77 head merged to main.
- `4845b1a` — the merge into main.
- `6190487` — current main.

## Notes

Later PRs (#138 board section truth, #171 agent status truth, #164 lens
expansion, and the 2026-10-04 review fixes) evolved parts of these files
further; where the literal lines from the integration event were
superseded, the current suites carry the evolved assertions (verified
above) and main CI is green. No #71/#77 assertion was lost in the
reconciliation. The individual #71 review defects (g9/g10, g14, g16, g24…)
remain owned by their own issues; this record certifies the integration
event only.
