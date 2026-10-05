# PR71 × PR77 overlap verification (issue #128)

The independent PR71 review pinned ten files as the #71/#77 integration
overlap. This record is the verification of that integration event: which
files needed edits, which passed as-is, and the evidence for both. It is a
verification record, not a repair ticket — the individual #71 defects are
their own issues. Where the record describes today's behavior, it says so;
the integration event and current main are kept separate.

## Verdict

- Exactly **one** of the ten files needed integration edits:
  `test/suite-shape.test.ts` (the single content conflict; its PINS table
  was regenerated from the actual merged tree at integration time).
- The other **nine auto-merged untouched**: every line added by each side
  (relative to the shared base `128412db`) is present verbatim in the
  integrated tree `5da02249`.
- All ten files' assertions ran green on the combined tree: the merge
  result was tested by PR-event CI and the merged commits by push-event CI.
- The guarded clean-abort path re-ran green against the post-#77 runtime,
  and both accepted restart reasons now have regressions (the missing
  second-reason test is closed in this PR as #113).
- Current main has since evolved the board chain (later board work), so the
  board section below states the integration state at `5da02249` separately
  from current-main semantics; current-main focused suites are green.

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
3. **Pins.** `test/suite-shape.test.ts` was regenerated at integration time
   from the actual merged listing; the committed test is a static guard, not
   a regenerator: it compares the `PINS` table with the `test/` directory
   listing and each file's registered `it(`/`it.skipIf(` count. It passes.
4. **Board chain.** Read engine snapshot fields, the web protocol validator,
   the signal derivations and the UI consumers; run their suites. The
   current terminal set carries a cross-build alarm that reads
   `src/ledger/states.ts` directly.
5. **Clean-abort.** Run `test/dispatch-server.test.ts` (heavy config) on the
   current tree — the guarded same-head re-arm runs against the post-#77
   WaveRunner, for both accepted restart reasons.
6. **Full suite.** GitHub CI check runs at the integration SHAs, read
   together with the checkout log (PR-event runs test a synthetic merge
   commit; push-event runs test the exact commit).

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

Both sides kept: #71 pending/wake snapshot fields, pagination and the
owner/machine split; #77 whole-PR lens classification and the review
runtime. Nothing from either side was dropped to make the merge.

## Board snapshot / classifier agreement

**At the integration event (`5da02249`):** the snapshot carried #71's
`unackedActionRequired`, `unackedNeedsOwner`, `wakes` and both pending
queues, alongside #77's whole-PR lens classification. That state still
counted terminal-bound machine rows in `unackedActionRequired`
(`countPendingActionRequired`) and still rendered attention pills on
concluded cards — the receipt rule came later.

**On current main (`6190487`), after later board work (#138):**

- **Engine** (`src/board/engine.ts`): `unackedActionRequired` is the live
  NEEDS GRU machine queue (terminal-bound receipts excluded via
  `countLivePendingActionRequired`), `unackedNeedsOwner` is the FOR YOU
  bell class, `wakes` counts durable Gru wake events; notifications
  paginate both pending routings under the receipt window; routing is
  `'fyi' | 'action-required' | 'needs-owner'`.
- **Protocol** (`web/src/lib/board-protocol.ts`): mirrors the routing union
  and both counters plus `wakes` and rejects malformed snapshots, so a
  shape drift fails the client loudly.
- **Signals** (`web/src/lib/board-signals.ts`): `unackedByJob` counts
  unacked machine rows bound to non-terminal jobs;
  `terminalBoundNotificationIds` classifies terminal-bound rows as closed
  receipts; `roundSummary` derives `used`/`unused`/`ran`/settled;
  `jobSignal` orders attention before liveness and returns null for
  concluded jobs.
- **UI** (`web/src/ui/board.ts`): NEEDS GRU renders the live machine queue
  and never rings the bell; the bell badge and toasts ride needs-owner rows
  only; concluded rows cannot re-enter NEEDS GRU.
- **Terminal-set agreement:** the ledger's `JOB_TERMINAL` is
  `{merged, done}` and the web's `isJobConcluded` is `{merged, done}`;
  `web/src/lib/board-signals.test.ts` reads `src/ledger/states.ts` and
  fails if the two ever drift.

## Guarded clean-abort

- The guarded same-head re-arm accepts two reasons
  (`service_restart`, `service_restart_missing_review_lane`).
- `test/dispatch-server.test.ts` covers `service_restart` end-to-end at the
  HTTP boundary, including the force/role negatives and the duplicate
  refusal.
- This PR adds the missing `service_restart_missing_review_lane` regression
  (issue #113) in both the digest (`test/silas-driver.test.ts`) and the
  guarded endpoint (`test/dispatch-server.test.ts`).
- Mutation check: deleting the second predicate from
  `src/dispatch/server.ts` fails the new endpoint test; deleting it from the
  digest classifier in `src/dispatch/silas-driver.ts` fails the new digest
  test. Both mutations were applied in a scratch run and reverted.

## Full-suite evidence (GitHub CI `Full suite (Node 22)`, all `success`)

- `234b1e9` — PR-event check on the synthetic merge result `81bdea0`
  (`234b1e9` merged into `6249e98`), i.e. the combined tree.
- `5da02249` — PR-event check on the synthetic merge result `0af5093`
  (`5da02249` merged into `6249e98`).
- `4845b1a` — push-event check on the exact merge commit.
- `6190487` — push-event check on current main.

## Verification runs (current main `6190487`)

- backend fast: `test/board-engine.test.ts` (35), `test/roles-definitions.test.ts` (10),
  `test/suite-shape.test.ts` (2), `test/silas-driver.test.ts` (45) — green.
- backend heavy: `test/dispatch-e2e.test.ts`, `test/dispatch-server.test.ts`
  (40, both restart reasons) — green.
- web: `board-protocol` (14), `board-bands` (33), `board-health` (13),
  `board-signals` (21), `board` UI (62) — 143 passed.

## Notes

Later PRs (#138 board section truth, #171 agent status truth, #164 lens
expansion, and the 2026-10-04 review fixes) evolved parts of these files
further; where the literal lines from the integration event were
superseded, the current suites carry the evolved assertions (verified
above) and main CI is green. No #71/#77 assertion was lost in the
reconciliation. The individual #71 review defects (g9/g10, g14, g16, g24…)
remain owned by their own issues; this record certifies the integration
event only.
