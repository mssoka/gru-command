# PR media: screenshots and clips in PRs

Owner rulings 2026-11-15: when a change is something a person can see, the
owner should see it before merging, without running the app. The minion
directs the shots; GC films them (ruling Q1, option C). GC binds each capture
to the exact commit it shows, shows it on the FOR YOU ready-PR card, and
writes it into the PR/MR description. Code decides when media is owed
(ruling Q4): a diff touching the repository's `[capture] paths` owes media
or a skip reason, and the owner sees "media owed" when it has neither.

The program is 4 PRs:

1. The media store, head binding, the PR/MR description publisher, the FOR
   YOU previews, and the minion rule that submits captures (#599).
2. **This PR:** the [`[capture]` table](#the-capture-table) in
   `.gru-command/worktree.toml`, the [shot list](#the-shot-list),
   [GC's camera](#gcs-camera), which films it at the exact head and re-shoots
   when the head moves, and [path-glob enforcement](#when-media-is-owed).
3. Perkins sees the stills in its review round, checks them against their
   captions, and flags visible changes that have no media.
4. Terminal (vhs/asciinema) and iOS simulator (simctl) capture adapters.

## The flow

```
minion writes shot-list.json ──▶ GC's camera films it at the head ──▶ media.captured (captured_by gc)
minion captures it itself    ──▶ POST /api/media (fallback)       ──▶ media.captured (captured_by minion)
                                                                            │
                        FOR YOU ready-PR card ◀── board snapshot ◀──────────┤
                        PR/MR description     ◀── publisher tick ◀──────────┘
```

1. **Direct.** A minion whose change alters something a person sees writes a
   [shot list](#the-shot-list) in its private operational artifacts folder:
   which page or flow proves which acceptance item, at which viewports, and
   a skip reason for anything that cannot be filmed. The worker rule
   `PR_MEDIA_RULE` (`src/dispatch/worker-rules.ts`) says how.
   - A change with nothing visible needs no media; a diff that touches
     `[capture] paths` anyway says why in the shot list's `skip`.
   - Review, read-only and other non-publishing jobs submit nothing.
   - A "before" shot of the merge base is filmed only for a shot that asks to
     compare (ruling Q6).
2. **Film.** [GC's camera](#gcs-camera) starts the app with `[capture] serve`
   on a port it picks, waits for `[capture] ready`, drives `agent-browser`
   through each shot, and stores every file bound to the head it filmed.
3. **Fallback: submit and bind.** When the repository declares no
   `[capture] serve`, or the output is not a web page, the minion captures
   it itself from its committed head (any screenshot or recording tool; the
   rule suggests `agent-browser screenshot` and `agent-browser record`). Each
   capture goes to `POST /api/media`, with the body
   sent from a file (`curl --data-binary @file`). The service accepts it only
   while the job's one live lane sits at exactly the named head, with no
   uncommitted tracked changes. So the record says which commit the capture
   was submitted at. A capture GC's camera filmed also proves where the pixels
   came from: GC ran the app at that head itself.
   - The capture is validated by magic bytes and bounds, then hashed.
   - It is written once into `<data_dir>/media/`: 0700 directories, 0600 files.
   - It is journaled as a `media.captured` job event naming its head. The
     event is the record.
   - Nothing is ever committed to the repository.
4. **Show.** The board's FOR YOU ready-PR row carries the captures bound to
   the row's exact head. Stills open full size and clips play in place. The
   board fetches the bytes with the pairing token, and the server re-checks
   the hash on every read. Captures of an older head are counted as
   superseded and never shown as current.
5. **Publish.** On the signal-poll tick (`[silas] poll_interval_ms`), the
   publisher keeps one section of the open PR/MR description current. The
   section sits between the marker lines `<!-- gc-media:begin … -->` and
   `<!-- gc-media:end -->`. It is replaced in place, and every byte outside
   it stays as written.

## The capture table

A repository opts in through `[capture]` in `.gru-command/worktree.toml`
([WORKTREES.md](./WORKTREES.md#1-bootstrap-manifest-18a)):

```toml
[capture]
paths = ["web/src/**", "web/index.html"]  # a diff touching these owes media or a skip reason
serve = "npm run dev -- --port {port}"    # starts the app on the run's port
ready = "http://127.0.0.1:{port}/"        # answered below 400 = up; or "output:<text>"
# url = "http://127.0.0.1:{port}/app"     # optional: the base the shots open
# ready_timeout_ms = 120000               # optional: 1000–600000
```

- **`paths`** are repository-relative globs in the subset every ecosystem
  agrees on: `*` (within one segment), `**` (whole segments, any depth) and
  `?`. A leading `!` excludes: a path it matches owes nothing, whatever else
  matches it (`"!web/**/*.test.ts"` keeps a test-only diff from owing
  media). Absolute paths, `..`, `[ ]`/`{ }` sets and a list of exclusions
  only are refused, so a glob never matches less than its author meant.
  `paths` may stand alone: media is then owed, and the minion submits it
  directly.
- **`serve`** must hold `{port}`: lanes are filmed side by side, so the app
  binds the port GC picks for the run. It runs in GC's own checkout of the
  commit being filmed (never in the minion's lane) with `/bin/sh`, in its own
  process group; `GRU_CAPTURE_PORT` carries the port too.
- **`ready`** is a loopback `http://` URL whose port is `{port}`, polled until
  it answers below 400, or `output:<text>`, matched against the app's output
  with ANSI colors removed. `serve` and `ready` come together.
- The table is read from the head's **committed** manifest, never from an
  edit the lane has not committed. Every refusal names its key, like
  `[verify]`. A head whose manifest does not parse films nothing, and its
  coverage says `unknown` with the refusal ([When media is owed](#when-media-is-owed)).

**Rolling out a `[capture]` table.** A GC service older than this release
refuses a manifest with `[capture]` as an unknown key, and with it every new
lane of that repository. Update every GC instance that works on a repository
before committing its first `[capture]` table. GC's own repository gets its
table in a follow-up for that reason.

## The shot list

The minion writes `shot-list.json` in its private operational artifacts
folder (`<data_dir>/projects/<project>/jobs/<job>/operational/`, named in the
workflow notes of every GC-built job). It is never committed.

```json
{
  "version": 1,
  "shots": [
    {
      "id": "ready-row",
      "proves": "AC2: a ready PR row shows its captures",
      "kind": "screenshot",
      "viewports": ["desktop", "mobile"],
      "steps": [
        {"open": "/board"},
        {"click": "[data-tab=for-you]"},
        {"type": "#filter", "text": "media"},
        {"wait_for_text": "What it looks like"}
      ],
      "compare": "base"
    },
    {"id": "sign-in", "proves": "AC3: the sign-in banner", "skip": "needs a real GitHub sign-in"}
  ]
}
```

- **`id`**: 1–40 lowercase letters, digits or dashes, unique.
- **`proves`**: the acceptance item the shot shows (at most 150
  characters); it becomes the caption, with the viewport when a shot has
  more than one, and `before (merge base)` for a before shot.
- **`kind`**: `screenshot` (PNG) or `clip` (WebM, recorded from the first
  page through a moment past the last step).
- **`viewports`**: 1–3 of `desktop` (1280×800), `tablet` (768×1024), `mobile`
  (390×844), or `{"width": W, "height": H}` (320–3840 × 320–2160).
- **`steps`**: 1–20, the first an `open`. `open` takes a path on the app
  (one leading `/`, never a URL); `click` a CSS selector; `type` a selector
  and the `text` that replaces the field's value; `wait_for_text` text that
  must appear.
- **`compare: "base"`** also films the shot at the merge base.
- **`skip`**: a shot that cannot be filmed carries only `id`, `proves` and
  why. A change with nothing to see writes `{"version": 1, "skip": "<why>"}`.
- A list holds at most 8 shots, skipped ones included, and plans at most 8
  files (each filmed shot × its viewports, twice with compare): the per-head
  cap.
- Selectors and texts never start with `-`: the browser tool would read them
  as its own options.

Every field is validated with a named reason (`shot_list_invalid`,
`shot_list_over_limit`, `shot_list_unreadable` for a link, anything but a
regular file (a named pipe is refused without being opened) or a file over
64 KiB). A refused list is shown on the FOR YOU card and returned to
the minion by `GET /api/media?job_id=`.

## GC's camera

The camera director (`src/media/director.ts`) ticks every 30 seconds while
`[pr_media] enabled` is true, and at once when a minion delivers. For each
live job with one live lane, it reads the `[capture]` table of the lane's
committed head and the job's shot list, then:

- **When it films.** As soon as the head is the minion's delivered head, or
  once the head has stood still for 60 seconds while the minion's attempt is
  closed, and only while the lane has no uncommitted tracked change (an
  edit in progress means the head is about to move). A head that moves is
  filmed again, and so is a shot list changed at the same head (a new
  script). One run at a time. A parked job keeps its coverage current and is
  never filmed (so its owed note is written at once); a run whose job is
  parked or closed is stopped.
- **Before the review freezes.** A delivery asks for a tick at once, so the
  delivered head is usually filmed while Perkins prepares its round. The
  review does not wait for the camera yet: PR 3 makes the review round read
  the head's stills.
- **How a run goes** (`src/media/camera.ts`):
  1. The browser tool is checked first, and a compare shot with no merge
     base is refused; neither waits for a budget slot.
  2. It holds one slot of the global verification budget for the rest of its
     life, under the reserved scope `pr-media-capture`. The scheduler's
     records of that scope are dropped, so a camera run is never verification
     evidence and never fences a review.
  3. It proves the lane is at the head.
  4. **Nothing runs in the minion's lane.** Each commit is filmed in a
     throwaway checkout under the run's private folder
     (`<data_dir>/media/.camera/<run>/`): `clone --shared`, then a detached
     checkout, so the repository gains no worktree, ref or index entry. The
     checkout is set up by that commit's own manifest (`[[link]]`, `[[copy]]`,
     `[[setup]]`), exactly as a fresh lane is. It is the commit, so its tree
     is clean by construction, and nothing the app writes (a regenerated
     tracked file, say) can reach the lane.
  5. Before shots go first, in a checkout of the merge base (set up by its own
     manifest, or the head's when the base has none): a base that cannot be
     set up fails the run before the head is filmed.
  6. In each checkout it starts the app on a free loopback port, waits for
     `ready`, films each shot through the web adapter, and ends the app's
     process group (SIGTERM, then SIGKILL after 5 seconds).
  7. It proves the lane is still at the head: a lane that moved yields
     nothing, and the new head is filmed instead. Anything still working in
     the run's folder (a browser whose close failed) is ended, and the folder
     is removed off the event loop.
  The run folders under `<data_dir>/media/.camera/` are GC's own: a process
  working inside one is ended when GC cleans up.
- **The web adapter** (`src/media/web-adapter.ts`) drives `agent-browser`
  with an argv, never a shell. Every command names a fresh `--session` and
  an empty `--config` file the run wrote, runs in the run's private folder,
  drops every `AGENT_BROWSER_*` variable, and passes `--allowed-domains`
  with the app's loopback host only. So neither the owner's browser profile
  nor a repository's `agent-browser.json` reaches the camera, and a step
  that navigates elsewhere fails instead of loading it. A step that fails is
  the step's (`step_failed`); a command that never finishes is the tool's.
  agent-browser must be installed on the GC host (`npm install -g
  agent-browser && agent-browser install`); without it the run fails
  `tool_missing`.
- **Storing.** A run stores all its files together, each a `media.captured`
  event with `captured_by: "gc"` and its `shot` (`run_id`, `shot_id`,
  `viewport`, `files`). A run counts only once all its files are stored. At a
  head, the newest complete camera run replaces older runs (they count as
  superseded); minion submissions at the head stay. A run that would pass the
  8 captures a head holds, with the minion's own, is refused (`media_limit`).
- **Journal.** `media.capture-started`, then `media.capture-filmed` (the
  media ids) or `media.capture-failed` (`code`, `detail`), each with the run
  id, head, the shot list's sha256 and the director's clock (`at`).
- **Failures.**
  - The shot list or the app must fix it (`step_failed`, `capture_invalid`,
    `media_limit`): final for that head and script. A fixed list or a new
    head is filmed again.
  - Infrastructure may cure it (`serve_failed`, `ready_timeout`,
    `tool_missing`, `budget_unavailable`, `checkout_failed`, `setup_failed`,
    `base_setup_failed`, `base_unavailable`, `lane_unreadable`,
    `store_failed`): retried 3 times, 10 minutes apart. A run that started
    and never got an outcome (the service crashed) counts as one of the
    three, so a crash can never loop.
  - `head_moved` and `stopped` (the service stopped, or the job was parked
    or closed) are recorded and are no attempt; the same head and script
    are tried again after 60 seconds. A stop at shutdown is recorded at
    once, before the run has cleaned up, so a service that exits first never
    leaves it looking like a crash.
- **Restarts.** A boot ends what the runs of an earlier process left
  running: every process whose working directory is a run's folder is ended
  (a process that only names one, a person's shell say, is not), with the
  group of each restored `pr-media-capture` slot that leads one, and the
  folders are removed (not when the working directories could not be
  listed: nothing is then ended, and the next boot tries again). No tick
  runs until this is done, or for at most 2 minutes. A restored slot
  whose pid is gone is released; a live pid working elsewhere (a reused pid)
  is never signalled. Shutdown stops a run in flight (bounded to 10 seconds)
  before the verification scheduler is disposed, and no run starts once it
  has begun. A run stopped while the service runs on (its job was parked)
  cleans up its folder itself.

## When media is owed

Owner ruling Q4: code decides. On each tick the director diffs the head
against its merge base (`git diff --name-only --no-renames`) and matches the
changed paths against the `[capture] paths` of the head's committed manifest
**and** of the merge base's. A path either side says owes media owes it, so
a diff cannot narrow, exclude or delete its way out of the paths it is
judged by. The lanes are read with `GIT_OPTIONAL_LOCKS=0`, so a tick never
takes the index lock a minion's own `git commit` needs. The result is
journaled as one `media.coverage` event whenever it changes:

| State | When |
|---|---|
| `owed` | the diff touches `[capture] paths`, and the head has no current capture and no skip reason |
| `skipped` | touched, and the shot list gives a skip reason (top-level, or every shot skipped) |
| `covered` | touched, and a capture is bound to the head |
| `not-owed` | no capture path is touched, but the minion wrote a shot list |
| `unknown` | owing could not be decided: a manifest that declares `[capture]` does not parse (`manifest_invalid: …`), or the merge base, a manifest or the diff could not be read. A read that failed is tried again on the next tick, never remembered as "not owed"; once the head is decided with nothing owed, a `not-owed` record sets it straight |

Each record carries the touched count, the first 10 paths, the globs they
matched, the skip reason, the shot list's state (`absent`, `valid`,
`refused`), the camera's (`pending`, `filming`, `filmed`, `failed`,
`unconfigured`) and the latest refusal or failure. A head that touches no
capture path and has no shot list records nothing.

Where it shows:

- **FOR YOU ready-PR card:** `📸 media owed: 3 changed files under [capture]
  paths (…) — no capture and no skip reason` in the alert color, or
  `📸 no media: <reason>`, or `📸 media check failed: <reason>` for an
  unknown head, and one line on the camera (filming, waiting for the head to
  settle, a refused shot list, or the failure it could not get past).
- **PR/MR description:** an owed head gets a note in the media section once
  the camera has nothing left to film at it ("Media owed: this PR changes 3
  files under the repository's capture paths (…) but has no captures and no
  skip reason at `<sha>`"), and a skipped head the shot list's reason, both
  markdown-escaped. A note left for an older head that nothing at the new
  head replaces gives way to one naming both heads, with no claim about the
  new one. Captures at the head always win over a note. An unknown head gets
  no note: the FOR YOU card says why.
- **The minion:** `GET /api/media?job_id=` returns the newest coverage.

## The capture API

All three routes take the service's `[auth]` token (`Authorization: Bearer …`),
like every service call. The service's address and token are in its instance
config.

| Route | Body / query | Answer |
|---|---|---|
| `POST /api/media` | `{job_id, head_sha, caption, role?, content_base64}` | `201` with the capture's metadata (no store path) |
| `GET /api/media?job_id=<id>` | — | the job's captures (metadata only), `camera` (the latest run: `started`, `filmed`, or `failed` with `code` and `detail`) and `coverage` (the newest [media coverage](#when-media-is-owed)) |
| `GET /api/media/<media id>` | — | the capture's bytes (`content-type` from the sniffed type, `no-store`, `nosniff`) |

- `head_sha` is the full 40-character lowercase sha of the lane's HEAD.
- `caption` is one line of 1–200 characters saying what the capture shows. It
  must not contain invisible or text-direction characters.
- `role` is `after` (the default) for the change, or `before` for the
  behavior it replaces.
- The body may carry wrapped base64.
- Each capture's metadata says `captured_by` (`minion` or `gc`); a GC capture
  also names its `shot` (`run_id`, `shot_id`, `viewport`).

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
- **The head owes media, or its shot list says why it needs none:** the
  section says so ([When media is owed](#when-media-is-owed)).

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
  - `not posted to the PR: <what to fix> (Gru Command checks again within 10 minutes)`
    when a hand fix of the description is needed, and `… every hour` once
    the 3 attempts have passed;
  - `board only` with `publish = "never"`;
  - `board only: publishing runs on the Silas signal poll, which is off on this instance`
    when Silas or its poll is off;
- `📸 N captures from an older head — superseded, not shown` when no capture
  is bound to the current head;
- `· filmed by Gru Command` (or `· N filmed by Gru Command`) for captures GC's
  camera filmed;
- the head's [media coverage](#when-media-is-owed) lines.

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
  `media.captured` (with `captured_by` and a GC capture's `shot`), the
  current captures at a head, read-back with hash verification, and the
  closed-job sweep.
- `src/media/capture-paths.ts`: the `[capture] paths` glob dialect.
- `src/worktrees/manifest.ts`: the `[capture]` table and the reserved
  `pr-media-capture` scope.
- `src/media/shot-list.ts`: the shot-list format, its validation and the
  planned captures.
- `src/media/camera.ts`: one camera run under the verification budget, and
  the boot cleanup of apps an earlier process left.
- `src/media/web-adapter.ts`: the `agent-browser` adapter.
- `src/media/director.ts`: the tick, media coverage, scheduling and retries.
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
  - `test/pr-media-capture.test.ts` (the table, globs, shot list, GC
    captures, the rule), `test/pr-media-camera.test.ts` (real app processes,
    a fake browser, the base checkout, the boot cleanup, the adapter's argv)
    and `test/pr-media-director.test.ts` (coverage, scheduling, re-shoots,
    retries, the FOR YOU block and the PR notes);
  - the engine, driver and web validator, client and render tests;
  - a real-service route check in `web/e2e/real-server.spec.ts`.
