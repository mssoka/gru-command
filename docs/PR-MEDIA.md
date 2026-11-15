# PR media: screenshots and clips in PRs

Owner rulings 2026-11-15. When a change is something a person can see, the
owner should see it before merging, without running the app. Minions capture
stills and short clips of their committed head. GC binds each capture to that
exact commit, shows it on the FOR YOU ready-PR card, and writes it into the
PR/MR description.

This is PR 1 of 4:

1. **This PR:** the media store, head binding, the PR/MR description
   publisher, the FOR YOU previews, and the minion rule that submits captures.
2. A `[capture]` table in `.gru-command/worktree.toml` and GC's own camera: the
   minion writes a shot list, GC records it at the exact final head and
   re-shoots when the head moves.
3. Perkins sees the stills in its review round and checks them against their
   captions, flagging visible changes that have no media.
4. Terminal (vhs/asciinema) and iOS simulator (simctl) capture adapters.

## The flow

```
minion commits ──▶ captures the head ──▶ POST /api/media ──▶ media.captured (bound to the sha)
                                                                     │
                       FOR YOU ready-PR card ◀── board snapshot ◀────┤
                       PR/MR description     ◀── publisher tick ◀────┘
```

1. **Capture.** The minion captures stills (`agent-browser screenshot`) or a
   short clip (`agent-browser record start <file>.webm` … `record stop`) of its
   committed head. The worker rule `PR_MEDIA_RULE`
   (`src/dispatch/worker-rules.ts`) tells every minion how. It applies only
   when the change alters something a person sees; nothing visible means no
   media.
2. **Submit and bind.** Each capture goes to `POST /api/media`. The service
   accepts it only when the job's live lane sits at exactly the named head
   with no uncommitted tracked changes. The capture is validated by magic
   bytes and bounds, hashed, written once into `<data_dir>/media/` (0700
   directories, 0600 files), and journaled as a `media.captured` job event
   naming its head. The event is the record. Nothing is ever committed to
   the repository.
3. **Show.** The board's FOR YOU ready-PR row carries the captures bound to
   the row's exact head. Stills open full size and clips play in place. The
   board fetches the bytes with the pairing token and re-verifies the hash
   on every read. Captures of an older head are counted as superseded and
   never shown as current.
4. **Publish.** On the signal-poll tick (`[silas] poll_interval_ms`), the
   publisher acts when an open PR/MR has captures bound to its current
   observed head. It writes one section into the description between
   `<!-- gc-media:begin … -->` and `<!-- gc-media:end -->`, replacing the
   previous section. Everything outside the markers is left as it was.

## The capture API

All three routes take the pairing token (`Authorization: Bearer …`), like
every service call.

| Route | Body / query | Answer |
|---|---|---|
| `POST /api/media` | `{job_id, head_sha, caption, role?, content_base64}` | `201` with the capture's metadata (no store path) |
| `GET /api/media?job_id=<id>` | — | the job's captures, metadata only |
| `GET /api/media/<media id>` | — | the capture's bytes (`content-type` from the sniffed type, `no-store`, `nosniff`) |

- `head_sha` is the full 40-character lowercase sha of the lane's HEAD.
- `caption` is one line of 1–200 characters saying what the capture shows.
- `role` is `after` (default) for the change, or `before` for the behavior it
  replaces.

Refusals are named:

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed fields (sha, caption, role, base64) |
| 400 | `media_empty` | The capture is empty |
| 404 | `job_not_found` | No such job |
| 409 | `job_terminal` | The job is closed |
| 409 | `no_active_lane` | The job has no live lane |
| 409 | `lane_unreadable` | GC could not read the lane's HEAD |
| 409 | `head_mismatch` | The lane is at another head; the body carries `lane_head` |
| 409 | `dirty_tree` | The lane has uncommitted tracked changes |
| 409 | `media_limit` | The head already has 8 captures |
| 409 | `pr_media_disabled` | `[pr_media] enabled = false` |
| 413 | `media_too_large` | The capture is over 10,000,000 bytes, or the body is over the cap |
| 415 | `media_unsupported_type` | Not one of the supported types |
| 415 | `media_invalid` | A truncated or undecodable image |
| 404 / 410 | `media_not_found` / `media_missing` / `media_altered` | On read: the capture is unknown, gone, or changed after it was recorded |

**Supported types.** PNG, JPEG, GIF and WebP stills; WebM and MP4 clips. The
type is identified by magic bytes, never by name. QuickTime `.mov` is
refused; convert it to MP4.

**Limits.** At most 10,000,000 bytes per capture. That is GitHub's attachment
cap for images and GIFs, and its video cap on the Free plan, so every
accepted capture can be published on every plan. At most 8 captures per head.

## The description section

The section is headed **What it looks like** and names the head it is bound
to (`Captured at <12-char sha> (this PR's head)`). It lists before shots
first. Each capture gets a caption line and its image or player.

Captions are markdown-escaped, so a caption can never become a link, an
image, a heading, or a comment that breaks the markers. A begin marker
without its end, or two sections, counts as damage: GC records a failure
asking for the half-section to be deleted by hand, and never guesses.

- **GitHub:** `gh pr edit <url> --body-file … --attach ./gc-media-N.ext …`
  (gh ≥ 2.99). gh uploads each file and rewrites the body's
  `./gc-media-N.ext` references to the uploaded assets. Any attachment gh
  appends after the body instead (a video player has no alt text) is moved
  back into the section with a second edit. Only lines on GitHub's
  attachment hosts are moved; a person's own text and links never are. The
  result is re-read and must hold no unlinked reference. GitHub Enterprise
  Server does not support `--attach`. On a private repository, attachments
  are visible only to signed-in users with access.
- **GitLab:** the project uploads API (`POST /projects/:id/uploads`), then the
  MR description update, with the same `GITLAB_TOKEN`/`GL_TOKEN` the MR reads
  use. Requests go only to a host the service supports, and the token is
  never forwarded on a redirect. GitLab renders WebM/MP4 uploads as players.

**Durable truth on both sides of the write.**

- `media.publish-attempt` is journaled before the first irreversible write.
- `media.published` follows on success, with the digest of the head and
  captures it carried.
- `media.publish-failed` follows on failure, with a bounded, redacted detail.

A digest already published is never re-sent. A failing digest is retried at
most 3 times, 10 minutes apart, and then shows as failed on the FOR YOU card
with its reason.

The publisher writes only when the PR still sits at the head the captures are
bound to: a head that moved, or a closed PR, is skipped and nothing is
recorded. Rewriting the section is idempotent, so a crash between an attempt
and its outcome is repaired by the next attempt. Re-uploaded attachments are
harmless orphans.

When the head moves and no capture of the new head exists yet, the old
section stays. It still names its own (older) head, so it never claims the
new one. The FOR YOU card says the captures are superseded.

## The FOR YOU card

A ready-PR row (Perkins approved at the head, CI green at the head,
mergeable) shows:

- the captures bound to that head, as a strip: stills link to the full-size
  image, and clips play inline (muted, with controls);
- a line such as `📸 2 captures at aaaa1111 · 1 older superseded · on the PR ✓`.
  The publication part reads `posting to the PR…` while a write is due,
  `not posted to the PR: <reason>` after the retries run out, and
  `board only` with `publish = "never"`;
- `📸 N captures from an older head — superseded, not shown` when no capture
  is bound to the current head.

Preview nodes are reused across board re-renders, so a playing clip keeps
playing. Each capture is fetched once per pairing; a refused fetch reads
`preview unavailable` until the next pairing.

## Configuration

```toml
[pr_media]
enabled = true          # false = the capture API refuses; nothing is shown or published
publish = "autonomous"  # "autonomous": GC writes the description section; "never": FOR YOU only
```

Both defaults are owner rulings (2026-11-15): PR media is on and autonomous
for every GC user. Publication rides the Silas signal poll, so it runs where
the GitHub/GitLab polls run.

## Privacy

- Captures show mock or seed data only: never real accounts, credentials,
  tokens or personal data. The minion rule says so.
- With `publish = "autonomous"` on a public repository, published media is
  public.
- The store is private durable state under `data_dir` and is never committed
  or logged. Captions are journaled; bytes are not.

## Code

- `src/media/store.ts`: sniffing, bounds, write-once storage,
  `media.captured`, and read-back with hash verification.
- `src/media/server.ts`: the three HTTP routes and the head binding.
- `src/media/publisher.ts`: the section text, the GitHub and GitLab writers,
  the tick, and the FOR YOU projection (`ownerPrMediaView`).
- `src/board/owner-actions.ts` and `src/board/engine.ts`: the `media` field on
  `ownerPrs` rows.
- `web/src/ui/board.ts`: the preview strip.
- Tests: `test/pr-media.test.ts`, `test/pr-media-server.test.ts`,
  `test/pr-media-publisher.test.ts`, plus web validator and render tests.
