# PR media: screenshots and clips in PRs

Owner rulings 2026-11-15: when a change is something a person can see, the
owner should see it before merging, without running the app. Minions capture
stills and short clips of their committed head. GC binds each capture to that
exact commit, shows it on the FOR YOU ready-PR card, and writes it into the
PR/MR description.

This is PR 1 of 4:

1. **This PR:** the media store, head binding, the PR/MR description
   publisher, the FOR YOU previews, and the minion rule that submits captures.
2. A `[capture]` table in `.gru-command/worktree.toml` and GC's own camera.
   The minion writes a shot list; GC records it at the exact final head and
   re-shoots when the head moves.
3. Perkins sees the stills in its review round, checks them against their
   captions, and flags visible changes that have no media.
4. Terminal (vhs/asciinema) and iOS simulator (simctl) capture adapters.

## The flow

```
minion commits ──▶ captures the head ──▶ POST /api/media ──▶ media.captured (bound to the sha)
                                                                     │
                       FOR YOU ready-PR card ◀── board snapshot ◀────┤
                       PR/MR description     ◀── publisher tick ◀────┘
```

1. **Capture.** A minion whose change alters something a person sees captures
   it from its committed head. Any screenshot or recording tool works; the
   rule suggests `agent-browser screenshot` and `agent-browser record`. The
   worker rule `PR_MEDIA_RULE` (`src/dispatch/worker-rules.ts`) says how.
   - A change with nothing visible needs no media.
   - Review, read-only and other non-publishing jobs submit nothing.
   - A "before" capture of the replaced behavior is added only when the
     briefing asks for a comparison.
2. **Submit and bind.** Each capture goes to `POST /api/media`, with the body
   sent from a file (`curl --data-binary @file`). The service accepts it only
   while the job's one live lane sits at exactly the named head, with no
   uncommitted tracked changes. So the record says which commit the capture
   was submitted at; GC's own camera (PR 2) will also prove where the pixels
   came from.
   - The capture is validated by magic bytes and bounds, then hashed.
   - It is written once into `<data_dir>/media/`: 0700 directories, 0600 files.
   - It is journaled as a `media.captured` job event naming its head. The
     event is the record.
   - Nothing is ever committed to the repository.
3. **Show.** The board's FOR YOU ready-PR row carries the captures bound to
   the row's exact head. Stills open full size and clips play in place. The
   board fetches the bytes with the pairing token, and the server re-checks
   the hash on every read. Captures of an older head are counted as
   superseded and never shown as current.
4. **Publish.** On the signal-poll tick (`[silas] poll_interval_ms`), the
   publisher keeps one section of the open PR/MR description current. The
   section sits between the marker lines `<!-- gc-media:begin … -->` and
   `<!-- gc-media:end -->`. It is replaced in place, and every byte outside
   it stays as written.

## The capture API

All three routes take the service's `[auth]` token (`Authorization: Bearer …`),
like every service call. The service's address and token are in its instance
config.

| Route | Body / query | Answer |
|---|---|---|
| `POST /api/media` | `{job_id, head_sha, caption, role?, content_base64}` | `201` with the capture's metadata (no store path) |
| `GET /api/media?job_id=<id>` | — | the job's captures, metadata only |
| `GET /api/media/<media id>` | — | the capture's bytes (`content-type` from the sniffed type, `no-store`, `nosniff`) |

- `head_sha` is the full 40-character lowercase sha of the lane's HEAD.
- `caption` is one line of 1–200 characters saying what the capture shows. It
  must not contain invisible or text-direction characters.
- `role` is `after` (the default) for the change, or `before` for the
  behavior it replaces.
- The body may carry wrapped base64.

Refusals are named:

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed fields (sha, caption, role, base64) |
| 400 | `media_empty` | The capture is empty |
| 404 | `job_not_found` | No such job |
| 409 | `job_terminal` | The job is closed |
| 409 | `no_active_lane` / `lane_ambiguous` | The job has no live lane, or more than one |
| 409 | `lane_unreadable` | GC could not read the lane's HEAD |
| 409 | `head_mismatch` | The lane is at another head; the body carries `lane_head` |
| 409 | `dirty_tree` | The lane has uncommitted tracked changes |
| 409 | `media_limit` | The head already has 8 captures |
| 409 | `pr_media_disabled` | `[pr_media] enabled = false` (every route) |
| 413 | `media_too_large` | The capture is over 10,000,000 bytes, or the body is over the cap |
| 415 | `media_unsupported_type` | Not one of the supported types |
| 415 | `media_invalid` | A truncated or undecodable image |
| 404 / 410 | `media_not_found` / `media_missing` / `media_altered` | On read: the capture is unknown (or the id is malformed), gone, or changed after it was recorded |

**Supported types.** PNG, JPEG, GIF and WebP stills; WebM and MP4 clips. The
type is identified by magic bytes, never by name. MP4 must carry a video
brand; QuickTime `.mov`, HEIC/AVIF stills, M4A audio and 3GP are refused.

**Limits.**

- **Size:** at most 10,000,000 bytes per capture. That is GitHub's attachment
  cap for images and GIFs, and its video cap on the Free plan, so every
  accepted capture can be published on every plan.
- **Count:** at most 8 captures per head.

## The description section

The section is headed **What it looks like**. It names the commit its
captures were taken at (`Captured at <12-char sha>`), lists before shots
first, and gives each capture a caption line and its image or player.

**Captions are markdown-escaped.** A caption can never become any of these:

- a link, an image or a heading;
- a mention (`@user`, or GitLab's `%`, `&` and `$` references);
- an autolink or emoji;
- a comment that breaks the markers.

**Markers count only as whole lines outside fenced code.** A description that
quotes the markers in prose or in a code block keeps every word.

**Damaged markers fail with a reason until someone fixes them.** A marker
line without its pair, or two sections, is recorded as a failure asking for
the stray lines to be deleted by hand. GC never guesses which text is its
own. After the usual 3 attempts it re-checks every hour (one read, no
upload), so a fix made later is still picked up.

**What the section shows**

- **Captures at the current head:** the section shows them. A run of
  submissions is left to settle for 2 minutes, so it is uploaded once.
- **The head moved and nothing is captured at it yet:** the section is
  replaced by a short note. The note says the earlier captures were taken at
  the old sha, names the new one, and says GC replaces it when the new head
  is captured. The description never presents an older head's pixels as
  current.
- **The head returns to an earlier commit:** its captures are written again.
  Only the newest publication counts as "on the PR".
- **The job is re-pointed at another PR:** the new PR gets the media.
  Publication is tied to the change URL.
- **A person deletes the section:** GC writes it again only when the head or
  the captures change.

**GitHub.** GC runs `gh pr edit <url> --body-file … --attach ./gc-media-N.ext …`.

- The files are named and attached in section order.
- gh uploads each file and rewrites the body's `./gc-media-N.ext` references
  to the uploaded assets.
- gh sometimes appends attachments at the very end of the description
  instead of rewriting their references (a video player has no alt text). GC
  moves exactly as many lines as there are references left unrewritten,
  taking the last lines of that trailing run on GitHub's attachment hosts,
  into the places they stand for. Anything else stays where it is,
  including a person's own screenshot added after the section.
- The result is re-read and must hold no unlinked reference.
- A partial upload is replaced by a note, never left as broken images. The
  note says GC will retry; after the last attempt it says the captures are on
  the board.

Preconditions:

- **gh ≥ 2.99:** checked by name, with a message that says to update gh. The
  check runs again on each attempt, so an upgrade is picked up without a
  restart.
- **GitHub Enterprise Server:** `--attach` is not supported there, so GC
  records one final failure; the media stays on the board.
- **Description length:** a description that would exceed GitHub's
  65,536-character limit fails before anything is uploaded. Like damaged
  markers, it is re-checked every hour after the third attempt, so a
  shortened description gets the media.
- **Private repositories:** attachments are visible only to signed-in users
  with access.

**GitLab.** GC uses the project uploads API (`POST /projects/:id/uploads`),
then the MR description update.

- The description is re-read just before the write, so an edit made during
  the uploads is kept.
- GC uses the same `GITLAB_TOKEN`/`GL_TOKEN` as the MR reads, sends it only
  to a host the service supports, and never forwards it on a redirect.
- GitLab renders WebM/MP4 uploads as players.

**Durable truth on both sides of the write.**

- `media.publish-attempt` is journaled before the first irreversible write.
- `media.published` or `media.publish-failed` follows, each carrying the
  digest of exactly what was meant: the change URL, the head and the
  captures.
- A failing digest gets 3 attempts, 10 minutes apart, and then shows as failed
  on the FOR YOU card with its reason.
- A failure that no fix to the description can change is recorded once, as
  final: GitHub Enterprise Server, or a GitLab host the service does not send
  credentials to.

The publisher writes only when the change still sits at the head the captures
are bound to. A head that moved, or a closed change, is skipped and nothing is
recorded. Rewriting the section is idempotent, so a crash between an attempt
and its outcome is repaired by the next attempt.

**Limits per tick.**

- **Changes:** a tick contacts at most 2 changes. A skip counts, because it
  cost a read.
- **Polls:** the publisher runs on its own in-flight guard, so a slow upload
  never delays the merge and CI observations of the signal polls.

## The FOR YOU card

A ready-PR row (Perkins approved at the head, CI green at the head,
mergeable) shows:

- the captures bound to that head, as a strip: stills link to the full-size
  image, and clips play inline (muted, with controls);
- a line such as
  `📸 2 captures at aaaa1111 · 1 older superseded · posted to the PR ✓`
  (MR for GitLab). The publication part reads:
  - `posting to the PR…` while a write is due;
  - `posting to the PR… (attempt 1 of 3 failed: <reason>)` between retries;
  - `not posted to the PR: <reason>` once the attempts run out;
  - `not posted to the PR: <what to fix> (Gru Command checks again every hour)`
    when a hand fix of the description is needed;
  - `board only` with `publish = "never"`;
  - `board only: publishing runs on the Silas signal poll, which is off on this instance`
    when Silas or its poll is off;
- `📸 N captures from an older head — superseded, not shown` when no capture
  is bound to the current head.

Previews are fetched once per pairing.

- **Reuse across re-renders:** preview nodes are reused, so a playing clip
  keeps playing.
- **Card disappears for a moment:** a card that is missing from a snapshot
  keeps its previews for 10 minutes.
- **Refused fetch:** it reads `preview unavailable: <reason>` (for example
  `media_altered`) until the next pairing.

## Configuration

```toml
[pr_media]
enabled = true          # false = every capture route refuses; nothing is shown or published
publish = "autonomous"  # "autonomous": GC writes the description section; "never": FOR YOU only
```

Both defaults are owner rulings (2026-11-15): PR media is on and autonomous
for every GC user. Publication rides the Silas signal poll, so it runs where
the GitHub/GitLab polls run.

## Retention and privacy

- **When a job closes:** its local captures are deleted on the next publisher
  tick, and a `media.swept` event records how many files and bytes went. The
  tick rides the Silas signal poll, so with Silas or its poll off, captures
  stay on disk until it runs. The PR/MR
  keeps the published copies, and the `media.captured` events keep the
  record of what was captured.
- **Data in captures:** captures show mock or seed data only, never real
  accounts, credentials, tokens or personal data. The minion rule says so.
- **Public repositories:** with `publish = "autonomous"` on a public
  repository, published media is public.
- **Private store:** the store is private durable state under `data_dir` and
  is never committed or logged. Captions are journaled; bytes are not.
- **Concurrent GitHub edits:** on GitHub, the description is read and then
  written by `gh pr edit`. An edit someone makes to the description in that
  window (during the uploads) can be overwritten. GitLab re-reads just
  before writing.

## Code

- `src/media/store.ts`: sniffing, bounds, write-once storage,
  `media.captured`, read-back with hash verification, and the closed-job
  sweep.
- `src/media/server.ts`: the three HTTP routes and the head binding.
- `src/media/publisher.ts`: the section text and marker lines, the GitHub and
  GitLab writers, the tick, and the FOR YOU projection (`ownerPrMediaView`).
- `src/board/owner-actions.ts` and `src/board/engine.ts`: the `media` field on
  `ownerPrs` rows.
- `src/dispatch/silas-driver.ts`: the publisher's tick and in-flight guard.
- `web/src/ui/board.ts`: the preview strip.
- Tests:
  - `test/pr-media.test.ts`, `test/pr-media-server.test.ts` and
    `test/pr-media-publisher.test.ts`;
  - the engine, driver and web validator, client and render tests;
  - a real-service route check in `web/e2e/real-server.spec.ts`.
