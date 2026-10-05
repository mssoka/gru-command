# Crew-heist-labels evidence pack (r7)

Assembled 2026-10-03T00:59:05Z. This directory exists so the acceptance evidence is
readable INSIDE the frozen review worktree: the confined review tools can
only read files in the tree at the frozen commit, so the capture pixels,
the vision-route reports and the CI receipt ride the commit itself.

## What was inspected

The captures are the CREW rail rendered from the isolated mock fixture
(`web/mock/server.ts`, synthetic data only, no live credentials or
sessions) by the declared scheduler scope `crew-heist-labels`
(`playwright test --project=crew-rail` after the web typecheck/build).
Each capture was read by the explicit vision route
(`zai-coding-cn/glm-5.3-flash`, headless pi, `@file` image attachment);
the verbatim reports are under `vision/`. The Playwright test itself
positively asserts, before each named capture is written: the short
authored row (`api docs pass` / `docs`), the bounded long/Unicode row
(`přepiš <script> & "café"` / `code`), role/state subtext and pill, the
full title/id in tooltip and accessible name, no primary `minion`
prefix, and no horizontal overflow at desktop/phone in light/dark.

## Files

- `captures/crew-dark-desktop.png` — sha256 `1de1979e2955031ab2d41210034f4f8af03ae89cd264da2bf4e2adf6f991b7c1`, 39769 bytes
- `captures/crew-dark-phone.png` — sha256 `e6ac71fda1161f35e6262b3e9dded953f7430929c03ec70d686e99012005c425`, 40737 bytes
- `captures/crew-light-desktop.png` — sha256 `5455de319f08545018adf04e323b6a02a06705c75c8a7addb6c2532dfad95e7b`, 40193 bytes
- `captures/crew-light-phone.png` — sha256 `b684b058898161edbc73bfd511d8b71a8e9bca3172c8a39a28ea0bb265eae44b`, 41165 bytes
- `vision/crew-dark-desktop.txt` — sha256 `b421c4655d7846659436d1690704f4a58eab9124193e2293d52e25d42ecf465f`, 1982 bytes
- `vision/crew-dark-phone.txt` — sha256 `8825515d9738513b7c8edc27b11f4a094d605eeb3cb84595f1f66c38539a3a9d`, 1699 bytes
- `vision/crew-light-desktop.txt` — sha256 `e7edbb62bac726f8a5cb3ed4845b66585e9af02273e54df707aa761d803a7354`, 2264 bytes
- `vision/crew-light-phone.txt` — sha256 `fe7cc5500e6578252d840d19733ee2d9f662817ea3670a7cb9b173bd084fd0aa`, 1309 bytes
- `ci/ci-run-37083150166-eeb62f091281.json` — sha256 `4125fa3deb814febf7a0c5f1c86e93b8488627875dfc2745421ad5650453707b`, 2805 bytes
- `ci/ci-run-37084328165-4c42ce2cb1f4.json` — sha256 `96f25abb518a51cb04a70f2b379a6d29756190146cf4f7bcdb36ca658c8aee01`, 2805 bytes
- `ci/prep-run-b1f96c2e-0377-48d7-a788-7b020a0afc20.json` — sha256 `c1bacdb0a6ef4a36fec104a4865ca2df844247fb713c0cbfe74fc2fcc73f48ce`, 1141 bytes

## Bound records

- Reviewed code head: `eeb62f091281d10477ed6be7ba602c171f050173`.
- Linux CI: run `37083150166` (CI), head
  `eeb62f091281d10477ed6be7ba602c171f050173`, conclusion `success`, event
  `pull_request` — the merge-result workflow, exact head, all steps
  successful including the full test suite.
- Host scheduler prep run: `b1f96c2e-0377-48d7-a788-7b020a0afc20` scope `crew-heist-labels`
  at head `eeb62f091281d10477ed6be7ba602c171f050173` — ok=True exit=0
  tracked_dirty=False duration_ms=303814
  output_bytes=23705 output_sha256=7272370a1f4b9a6fc40875ce2fe1ceb3f3a27c37bc60b4e2d28278726630ef2a.

- Evidence-chain CI: run `37084328165` (`CI`), head
  `4c42ce2cb1f4bd8807cab9d342c5731ae1546aba`, conclusion `success`, event
  `pull_request` — re-validates the evidence-and-spec commits. The first
  evidence commit failed this repository's hygiene gate on one embedded
  host path; that field was removed and this run is green.
- The host scheduler `full` run at the frozen head is executed after this
  evidence commit is created; it is bound in the host ledger to that exact
  SHA, and the host appends the ledger-backed receipt to the frozen
  specification when the review round is armed. Its raw capture stays
  host-side.

## Relationship to the frozen head

This directory, the r7 section of `spec-crew-heist-labels.md` and the
`web/playwright.config.ts`/`.gru-command/worktree.toml` records are the
only files added after the code head above. A commit cannot contain a
receipt of itself (writing the receipt moves the head): the attached CI
receipts bind the reviewed code and the evidence chain; the frozen head's own merge-result run
is recorded on the PR, and the host full receipt is bound by SHA as
described above.

## Limitations

- The owner's private reference upload is NOT published here: it stays
  host-side. The frozen briefing carries its description; the acceptance
  comparison is against the current render, supplied above as pixels.
- Vision reports are verbatim model reads of the pixels. The model
  normalizes small monospace glyphs to uppercase and can misexpand a
  four-character suffix that looks like a word tail (`nion` read as a
  clipped `MINION`); the deterministic browser assertions pin the exact
  lowercase text (`nion`/`docs`/`code`) and the four-grapheme bound, and
  the rail CSS keeps the badge `flex: none` with a 6px gap, so the
  reported "clipped" badge is a model misread recorded here verbatim.
- Non-minion rows keep their existing `id`-prefix badges by design; the
  vision prompt expectation of four-character badges applies to minion
  rows only.
- The full smoke Playwright project is red from pre-existing merged-main
  drift (chat goldens last refreshed before the FOR YOU band and other
  mock changes landed) plus two chat-reflow assertions that failed after
  a websocket ECONNRESET under host load. It is not this display-naming
  lane's acceptance surface and no green claim is made for it.

## State chips vs supervision marks (blind review 2026-10-05)

The captures show minion rows carrying BOTH an `idle` state chip (right
edge) and a `⛔ stopped` supervision mark (subline) — e.g. the
`mock-minion` row. That is intentional two-surface truth, not a
contradiction: the chip reads the agent row's LAST RECORDED state
(`idle` — what the ledger last heard), while the supervision mark reads
the live supervisor's verdict for the same row (`stopped` — breaker
tripped after 3 restarts, holding the lane for an owner ack). The two
disagree exactly while a stop is owner-held; the row's tooltip names
the supervision state and restart count, and the alert accent is driven
by the supervision stop, so a fault never hides behind a calm chip.
