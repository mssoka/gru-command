# Theme baselines — before/after evidence, approved provenance, inspection

## What these files are

`before/` holds the four darwin theme baselines as committed at `81d3f10`
(last content write 2026-09-27, commit 39f68e4). `after/` holds the same four
baselines as they stand at the frozen product head. Both sets are hashed in
`manifest.json`. The refresh was performed deliberately with
`--update-snapshots=all` on exactly the two `themes` screenshot tests through
the committed `wizard-bmad-snapshot-update` scope (runs `b40b49d4` and
`8593dbef`, both exit 0); no other snapshot was touched, no mask was added,
no tolerance changed (`maxDiffPixelRatio: 0.02` stays as authored), and no
test logic was altered.

## Why the old baselines no longer matched — approved UI provenance

The snapshot is a whole-page capture (chat pane + board + rail), so any
approved board/chat UI change invalidates it. Between 2026-09-27 and the
current head, the following owner-approved UI landed on main:

- **FOR YOU — permanent owner-action band** — `1d349af` (owner approval
  2026-09-28) with follow-up repairs `a239561`; carries pending needs-owner
  acknowledgements and evidence-bound ready PRs.
- **Needs-owner notifications / acks** — `083dd7b` (E7 supervision +
  notification acks); the ack row rendered in the band comes from this.
- **Owner chime** — `0d03c6c` (feature) and `9bdb9a9` (review findings).
- **Clean-chat service band** — `4f4ebc8` (owner clean-chat clause,
  2026-09-23): tool lines collapse into one expandable band.
- **Working-flavor status chip** — `20b7add` (owner-approved 2026-10-01,
  `GRU-WORKING-FLAVOR-20261001`), plus this lane's console/tablet geometry
  pin (browser-correction commit in this diff).
- The board mock's sample notifications (`mock-n3`, needs-owner crash-loop
  breaker) are part of the same E7 fixture lineage.

Each feature carries its own tests in the repository (owner-band and
notification cases in `web/src/ui/board.test.ts`, chime cases
`web/src/ui/owner-chime.test.ts`, band collapse in
`web/src/ui/chat-service-band.test.ts`, flavor cases in
`web/src/ui/chat-working-flavor.test.ts` and the e2e specs). None of these
features changed with this lane; the baselines simply had to catch up.

## Individual inspection of the refreshed (`after/`) images

Performed image by image against the approved behavior above; each shows
exactly the cited approved UI, nothing absent and nothing unexpected added:

- **`smoke chat-light`** — chat pane with the mock echo reply and collapsed
  service band; board shows the FOR YOU band with the ready-PR row
  (job title, `ready for you`, OPEN PR) and the needs-owner ack row with its
  clock time; owner-chime icon present; rail and chip rail unchanged.
- **`smoke chat-dark`** — the same page in dark: identical structure, dark
  surfaces, same band/card/ack content (the ack row's clock string is live
  text; see residual churn below).
- **`real real-chat-light`** — real-service hermetic instance: FOR YOU band
  in its empty state ("nothing needs you / pending owner actions land here"),
  "the board is quiet" panel, crew rail with the session row; chat pane with
  the echo reply.
- **`real real-chat-dark`** — the same real page in dark; the baseline that
  changed-mode left stale (7.45 % off) is now the current approved render.

## Residual live churn vs the unchanged allowance

Re-measured after the refresh: the four baselines differ run-to-run by
≈0.07 % of pixels (clock strings, fixture-second counters, fresh session
ids), well inside the authored 2 % allowance. That churn is inherent to the
live page and was covered by the pre-existing tolerance by design; no
tolerance was changed to accommodate the refresh.

## Visual-intent statement

No genuine visual-intent question remains after this inspection: every diff
region maps to the approved features cited above and to the lane's own
geometry repair. The refresh did not introduce or accept any unapproved UX
change. If authority nevertheless disagrees on any specific region, the
precise question would be: "is <region> in <after-image> an approved current
render, or an unintended change to be reverted?" — pointed at the exact file
and region, not resolved by passing snapshots.
