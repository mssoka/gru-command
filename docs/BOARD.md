# Board — the live dashboard (E6)

The board is the product's flagship window: repo-grouped job rows with
state chips, review rounds with per-lens live chips, the crew rail
(gru, silas, minions, and lens children), the notification center, and
per-agent transcript views — all fed live from the ledger through the
event bus. The browser is the only required window; the board is
read-only by design (dispatch authorship UI lands with E8).

Data flow:

```text
runtime adapters ──(registry event tap)──► board engine ──► ledger rows + events
                                                │
ledger API writes ──► event bus ──► board WS push (fresh snapshot)
```

The engine maps adapter events to ledger rows/events (spawn → agent
registered; state → agent state; turn lifecycle → activity + lens-chip
derivation; fatal error → lens error + notification). Every snapshot is
read straight from the ledger — a restart can never diverge from the
record.

## HTTP API (token-authed: `Authorization: Bearer <pairing-token>`)

| Method + path | Purpose |
|---|---|
| `GET /api/board` | the full snapshot: `repos[]` (grouped jobs + rounds + lens chips), `agents[]`, `notifications[]` |
| `GET /api/transcripts` | session transcript list (newest first; ledger-bound agents carry ids/labels) |
| `GET /api/transcripts/file?file=<rel>[&q=&before=&limit=]` | one transcript: paged entries (`before` = exclusive upper index, newest-first, `nextCursor`) or case-insensitive search — newest-first scan under a bounded cap, `scanned`/`total` disclose truncation |
| `POST /api/jobs` | `{id, repo, title, baseBranch?}` → job (`dispatched`) |
| `POST /api/jobs/:id/status` | `{status}` — validated against the [job machine](./LEDGER.md) |
| `POST /api/rounds` | `{jobId, lenses? (default 7), targetRef?}` → round (`pending`) |
| `POST /api/rounds/:id/status` / `:id/verdict` | `{status}` / `{verdict}` |
| `POST /api/agents` | `{id, role, label?, jobId?, roundId?, sessionFile?}` (upsert) |
| `POST /api/agents/state` | `{id, state}` |
| `POST /api/notifications/:id/shown` | `{surface}` — display receipt (idempotent per surface; the shown:true doctrine) |
| `POST /api/notifications/:id/ack` | `{by?}` — owner/FYI ack; refuses machine rows (400), and owner ack re-arms an open breaker |
| `POST /api/notifications/:id/disposition` | `{detail}` — authenticated Gru disposition for an action-required ID after substantive action; resolves it with a ledger event and closes any unresolved-attention owner follow-up; never clears unrelated owner stops |
| `POST /api/lenses/bind` | `{roundId, lens, agentId}` — chip follows the agent's events |
| `POST /api/lenses/outcome` | `{roundId, lens, state: done\|error, note?}` (live derives from agent events — never posted) |

401 without/with a bad token; **503 `not_configured`** when no pairing
token exists (empty token = locked door, never open). Illegal
transitions and unknown entities are 400/404 with the reason in
`detail`. Bodies are capped (200 KB).

## Board WebSocket — `/board/ws`

JSON frames; **first frame must be `auth`** (same pairing token, 5 s
deadline); transport-level ws pings keep half-open connections from
lingering (two missed pongs terminate → client reconnects):

```jsonc
→ { "type": "auth", "token": "…" }
← { "type": "auth_ok" }
← { "type": "board", "snapshot": { … } }   // immediately, and on EVERY change
← { "type": "error", "message": "…", "fatal": true }  // then close
```

Deliberately simpler than the chat contract: snapshots are **idempotent
and last-write-wins** — no replay/seq machinery. Rapid changes coalesce
(~150 ms) into one push. A reconnect starts over (auth → fresh
snapshot). Post-auth inbound frames are ignored (board clients only
listen). Bad token / non-auth first frame / timeout → fatal error +
close. The client validators live in `web/src/lib/board-protocol.ts`
(parity-tested against the server parser in `test/board-frames.test.ts`
— both directions).

Upgrade routing on the one HTTP server: the chat handler owns `/ws`
(passing declared sibling paths), the board handler owns `/board/ws`
and — as the last-attached handler — terminates unclaimed upgrade paths
(no stray socket lingers).

## The UI (`web/`)

- **Cockpit (v6.1):** the estate is full-width. The sticky **command bar**
  carries the brand + `ONE GRU · ONE WINDOW`, the monospace ticker
  (`MODE` · `RADAR` · top review round), the notification bell, the
  owner-chime speaker, theme and
  settings — no lens toggle: chat is always docked on desktop and the FAB
  owns mobile chat. Below it the sticky **status chip rail** relocates the
  v4 health row globally (DEPLOY → REVIEWS → SILAS → ALERTS → VERIFY →
  CURE → TRACKERS); the TRACKERS chip renders the KPI counts as labeled
  fields (`HEISTS 17 · working 2 · in review 2 · …`, every number a
  `data-kpi` span tied to the same `boardKpis` derivation the v4 strip
  used). At ≥1100px it is three panes — chat (~30%, collapsible,
  resizable) | board | crew rail — with 4px drag splitters (sizes persist
  per breakpoint; double-click resets). At 900–1099px the board + rail
  hold the page and chat overlays via the Gru FAB (right drawer, dimmed
  board behind); below 900px the rail stacks under the board and the FAB
  opens a bottom sheet.
- **Dashboard:** a permanent **FOR YOU** owner band sits ABOVE the job
  bands (owner approval 2026-09-28): the owner's pending obligations —
  unacked `needs-owner` rows (Ack, with consequence copy that names what
  the ack does and does NOT do — a quota/breaker ack re-arms the worker
  but never clears code/test/review holds) plus the server-projected,
  evidence-bound **ready PRs** (see below). Viewing completes nothing:
  the header count is owed actions, not unseen rows; the count only
  moves on an authoritative ack (any device) or confirmed merged/closed
  state. Rows are deterministic (newest first, stable
  `owner-ack:{id}`/`owner-pr:{jobId}` ids), focus survives snapshot
  re-renders, and the older tail hides behind a `+N older pending`
  expander — the engine already merges EVERY unacked needs-owner row
  into the snapshot, so no pending obligation is lost to the bounded
  feed. The PR action is **OPEN PR** (external https link only) — a
  link click is never a merge; readiness is projected SERVER-side
  (`ownerPrs` on the snapshot) from the conjunction of durable exact-head
  facts: `in-review` job + recorded PR, a `github.branch-state`
  observation whose `pr_url` matches the recorded PR with the pull
  explicitly OPEN (`pr_open:true` — a closed-without-merge pull is never
  an open obligation), `merged:false`, `mergeable_state:clean` observed
  for THAT head (a moved head invalidates the old mergeability — the
  poll fails closed until GitHub answers for the new head), CI observed
  **green at that exact sha**, and the job's NEWEST review round
  `verdict-posted` / `approved` with its frozen `targetRef` equal to that
  sha. Anything
  missing, stale, moved, dirty, blocked, pending/failed, or
  changes-requested renders no row (fail closed — no heuristic).
  Known limitation (deliberate): GitHub-native review approvals beyond
  `mergeable_state` are not separately projected; the Perkins verdict is
  represented by the head-bound approved round. Then the **attention
  bands** — NEEDS GRU → IN FLIGHT → SETTLED →
  COLD, recency inside each band — rendered as full-width **dense rows**
  (line 1: dot + title + status chip; line 2: repo + branch + heist/minion
  ages + PR link), with sticky band headers carrying counts and hairline
  dividers. Failing rows (blocked/error, aborted round, errored lenses
  without a verdict) are tinted with a left alert accent. NEEDS GRU is
  always visible (empty = calm “nothing needs Gru”); FOR YOU belongs only
  to the owner band. SETTLED is a rolling
  window (latest 10 + `+K older settled`, session-expanded; concluded
  jobs render their last round quiescent — no stale blocker pills). Click
  a row to disclose lane + rounds (v3 collapse, persisted per job).
  Round rows carry per-lens chips (`○ pending` gray · `◉ live` yellow ·
  `✓ done` green · `✕ error` red · `— not used` neutral gray, no pass mark)
  behind a click.
- **Crew rail:** CREW (n) / TRANSCRIPTS tabs above dense rows — a
  status dot + name + short hash, a `role · state` subline (with turn
  age and supervision marks), and a right-aligned state chip; error rows
  carry the alert accent; disposed rows collapse behind a dashed `+N
  disposed` footer. Clicking an agent with a session file opens its
  transcript. The silas chip is LIVE when
  `[silas] enabled` (default): the hosted ops session (`silas-ops` slot)
  appears there whenever its wake turns run, and its follow-through lands
  on the ledger as `silas.*` events (`silas.pr-registered`,
  `silas.review-triggered`, `silas.directive-sent`, `silas.rebrief`,
  `silas.escalated`, `silas.wake`) — visible in the event stream like
  every other transition.
- **Notification center (E7; routing split 2026-09-23):** the bell panel
  renders the durable notification log in three bands — FOR YOU
  (all pending needs-owner rows, even older than the bounded latest feed:
  owner-only decisions and stops whose ack re-arms supervision), NEEDS GRU
  (all pending machine rows, including those older than the recent feed;
  it wakes Gru once and refuses human Ack), and FEED (FYI rows). The bell
  is the alert/history surface: it shares the SAME authoritative owner
  projection as the board's permanent FOR YOU band — pending acks AND
  ready PRs, so the two surfaces never disagree about what the owner
  owes (the badge and toasts still count needs-owner notifications
  only); opening it never completes an obligation. A machine
  alert left unresolved 30 minutes after delivery opens a separate
  owner-only follow-up in FOR YOU; Gru's later disposition resolves it. The badge and live
  toasts serve needs-owner only; every displayed row earns a shown receipt
  per surface (a display receipt is not an acknowledgement); acking an
  owner row clears it where an ack has meaning (a breaker row re-arms
  supervision). Informational owner stops earn the same unread badge as
  errors. The
  wake tracker chip counts durable Gru wakes (`gru.wake` events). Live
  needs-owner arrivals toast (plus a browser notification when permission
  was granted).
- **Owner chime (owner ruling 2026-09-23):** the ONE sound — a soft
  two-note Web Audio chime on NEW unresolved `needs-owner` arrivals
  only (`action-required`/NEEDS GRU/FYI stay silent by design — machine
  queue, machine noise). Audio arms on the first user gesture; an
  unarmed arrival pulses the bell badge instead (visual fallback). The
  header speaker toggles a persisted mute, separate from the bell's
  panel navigation (badges still count), and chimes are throttled to
  one per 30 s (a burst is one sound + the merged badge).
- **Transcripts:** drawer with newest-first pages (`load older` by entry
  cursor), debounced server-side search with snippet matches that
  scroll+flash the entry, a wrap toggle (default `pre-wrap` — long lines
  unwrap, never clip), thinking collapsed under `<details>`, and torn/
  skipped line counts disclosed. Parsed with the pi SDK's own session
  parser; claude-code raw-frame forensics render as user/assistant/turn
  entries (delta `stream_event` frames dedupe away).

### Dev feed (mock)

`npm run dev:web` proxies `/api` + `/board/ws` to the dev-only mock
(`web/mock/server.ts`), which serves a GENERIC sample snapshot
(`demo-api`, `sample-site`, one live 7-lens round in mixed states) —
`POST /__pulse` on the mock port pushes a fresh copy. No real project
names anywhere, ever.

## Tests

- Backend (`test/`): ledger migrations + API of record + state machines;
  board engine (adapter-event mapping, lens lifecycle, restart rebuild,
  notifications); board server (HTTP auth/validation, WS push, locked
  door, upgrade terminator); transcripts (list/page/search/torn-tail/
  traversal/claude-frames); frame parity vs the web validators.
- Web (`web/src/lib/*.test.ts`): board validators + client contract
  against an in-test WS/HTTP server (auth, snapshot push, fatal, noise
  tolerance, stop).
- E2E (`web/e2e/`): mock board render + transcript drawer; real-service
  board (API-seeded jobs, live push, crew rail, real transcript open +
  search, 401 doors, phone board-first).
