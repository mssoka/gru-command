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
record. Agent rows additionally carry the #171 runtime classification
(`current` / `historical` / `unverified`) derived per snapshot from live
ownership evidence (registry handles ∪ supervision views) and a
supervision-corrected `status` — pure reads, so startup, reconnect and
restart produce the same truth without data edits.

## HTTP API (token-authed: `Authorization: Bearer <pairing-token>`)

| Method + path | Purpose |
|---|---|
| `GET /api/board` | the full snapshot: `repos[]` (grouped jobs + rounds + lens chips), `agents[]`, `notifications[]` |
| `GET /api/transcripts` | session transcript list (newest first; ledger-bound agents carry ids/labels) |
| `GET /api/transcripts/file?file=<rel>[&q=&before=&limit=]` | one transcript: paged entries (`before` = exclusive upper index, newest-first, `nextCursor`) or case-insensitive search — newest-first scan under a bounded cap, `scanned`/`total` disclose truncation |
| `POST /api/jobs` | `{id, repo, title, baseBranch?}` → job (`dispatched`) |
| `POST /api/jobs/:id/status` | `{status}` — validated against the [job machine](./LEDGER.md); `binned` is the terminal discard (any non-terminal source; never resumable) |
| `POST /api/jobs/:id/closeout` | `{expected_status, expected_pr_url, provider, reason}` — guarded administrative closeout of a parked PR-backed lane whose recorded provider observation is CLOSED-without-merge; audited, idempotent, refusals are `409 closeout_refused` + `code` ([OPERATIONS.md](./OPERATIONS.md)) |
| `POST /api/rounds` | `{jobId, lenses? (default 9), targetRef?}` → round (`pending`) |
| `POST /api/rounds/:id/status` / `:id/verdict` | `{status}` / `{verdict}` |
| `POST /api/agents` | `{id, role, label?, jobId?, roundId?, sessionFile?}` (upsert) |
| `POST /api/agents/state` | `{id, state}` |
| `POST /api/notifications/needs-owner` | `{title (1-500), detail (1-4000), decision (required typed object: question, context, recommendation, reservedClass, whyNotDelegable, discussion, options), idempotencyKey? (1-128 of [A-Za-z0-9._:-])}` — Gru's owner escalation into FOR YOU (decision #100, 2026-10-12); a bare title/detail post is `400`. Without a key every valid request is its own row. With a key the key names ONE escalation: a retry with the same key and same title/detail/decision returns the existing row (`200`, no second row or bell; first creation is `201`); the same key with a changed title/detail/decision is `409 idempotency_conflict`; a new key is a new decision. A row written before typed decisions were required (stored `decision: null`) that an identical title/detail replay names is upgraded in place while it is still open — it adopts the typed decision (`200`, the same single FOR YOU item, a `notification.decision-adopted` event recording the authenticating `credential` — `shared-bearer` — and `declaredActor: null`, since the bearer proves only a paired caller) — and is `409 idempotency_conflict` with `code: legacy_closed` once the owner has already acked or resolved it, or `code: decision_present` when the row stores a decision (even one that no longer parses) or already records a choice; a row that vanished before adoption is `404`. Only owner-escalation rows adopt: a machine row is refused as `not_owner_decision` (checked before anything else on the row), and every provenance credential must be non-empty — a blank one is a server bug, refused as `BlankProvenanceCredentialError` before anything is written (#395, #396). Retry an uncertain outcome with the SAME key |
| `POST /api/notifications/:id/shown` | `{surface}` — display receipt (idempotent per surface; the shown:true doctrine) |
| `POST /api/notifications/:id/ack` | `{by?}` — feed/notice acknowledgement only; refuses machine rows (400). The UI shows it only on FYI rows (`Mark seen`) |
| `POST /api/notifications/:id/decision` | `{optionId, expectedDecision, by?}` — records the owner's choice only when the full typed decision still matches what the caller displayed, so a reused option ID cannot bind an old label to a new consequence (`409 decision_changed`). A recorded decision is distinct from resolution; duplicates are idempotent and a different option is refused (409) |
| `POST /api/notifications/:id/decision-options` | `{options, by?}` — the supported discussion bridge: attaches agreed options to an undecided, unresolved, discussion-only `needs-owner` decision (audited as `notification.decision-options`). It records NO choice and every other row shape is refused (409: `not_discussion`, `decision_recorded`, `not_open`, `no_decision`, `not_owner_decision`) |
| `POST /api/notifications/:id/disposition` | `{detail, actor?}` (non-empty detail). **Actorship (decision #99, 2026-10-12):** `actor` may only be omitted or `"gru"`, else 400; the shared bearer proves a paired caller, not Gru — `notification.resolved` records `credential: 'shared-bearer'` and the caller-declared `declaredActor`) — authenticated Gru disposition for an action-required ID after substantive action; resolves it with a ledger event and closes any unresolved-attention owner follow-up; never clears unrelated owner stops. A blank detail is refused (400) before anything runs. Disposing an open `supervision.breaker` (or re-arm-fenced) alert re-arms the stopped lane through the guarded recovery-authority fence: a refusal is a typed `409 rearm_refused` and consumes nothing; a throwing guard is `502 rearm_failed`; the response carries `rearm: accepted \| not_applicable \| superseded` (accepted = a stopped lane was re-armed, not_applicable = pure record, superseded = the stop closed without a restart because its captured turn was superseded by a park/resume or fresh authority — continue the lane with a fresh re-brief/directive, #385). A fence appearing after acceptance keeps the stop visible and raises a fresh bound alert, so the debt always has a live control. On a `needs-owner` row it records FOLLOW-THROUGH for an already-recorded owner decision (an undecided row is refused: resolution never silences an unanswered question), with the same `credential`/`declaredActor` provenance on its `notification.resolved` event (#396) |
| `POST /api/lenses/bind` | `{roundId, lens, agentId}` — chip follows the agent's events |
| `POST /api/lenses/outcome` | `{roundId, lens, state: done\|error, note?}` (live derives from agent events — never posted) |

401 without/with a bad token; **503 `not_configured`** when no pairing
token exists (empty token = locked door, never open). Illegal
transitions and unknown entities are 400/404 with the reason in
`detail`; a guarded closeout refusal is a typed `409 closeout_refused`
whose `code` names the refusing guard. Bodies are capped (200 KB).

PR state derives from the record: a `merged` job reports `merged`; a
terminal non-merge job (`done`, including a closed-without-merge
administrative closeout, and `binned`, a discarded lane) is a closed
receipt — its registered PR is never presented or counted as open (and
closure never infers a merge); any other lane with a registered URL
reports `open`. A binned row renders with the distinct dashed muted
`binned` badge and stays in COLD behind an explicit “Show N binned
records” disclosure (the band's complete count includes it; opening the
disclosure is inspection only — never an ACK, a transition or an
approval). Binned rows keep their full round history in the expanded
body: the discard is inspected, not erased.

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
  owns mobile chat. Below it the sticky **slim status strip** renders the
  v4 health row as labelled status pairs (DEPLOY → REVIEWS → SILAS →
  ALERTS → VERIFY → CURE) plus the Jev decisions / NEEDS GRU / wake facts
  and the HEISTS / PRS / CREW count groups (`HEISTS 17 · working 2 · in
  review 2 · …`, every number a `data-kpi` span tied to the same
  `boardKpis` derivation the v4 strip used). Numeric slots are reserved
  (`tabular-nums` + a floor), so a count crossing 9→10→100→1000 never
  reflows its neighbours. At ≥1100px it is three panes — chat (~30%, collapsible,
  resizable) | board | crew rail — with 4px drag splitters (sizes persist
  per breakpoint; double-click resets). At 900–1099px the board + rail
  hold the page and chat overlays via the Gru FAB (right drawer, dimmed
  board behind); below 900px the rail stacks under the board and the FAB
  opens a bottom sheet.
- **Dashboard:** a permanent **FOR YOU** owner band sits ABOVE the job
  bands (owner approval 2026-09-28; decision-inbox release 2026-10-11):
  the owner's pending obligations — typed owner decisions (question,
  recommendation, options with consequences; choosing one RECORDS the
  choice and the row stays "awaiting follow-through" until its producer
  resolves it), owner notices whose action is outside the app (no fake
  Ack), lesson proposals, and the server-projected, evidence-bound
  **ready PRs** (see below). Viewing completes nothing: the header count
  is owed actions, not unseen rows; a row settles only on recorded
  follow-through or confirmed merged/closed state. Rows are
  deterministic (newest first, stable `owner-decision:{id}` /
  `owner-notice:{id}` / `owner-proposal:{id}` / `owner-pr:{jobId}` action
  keys), focus survives snapshot re-renders, and the older tail hides
  behind a `+N older pending`
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
- **Crew rail (#171 truthful agent status):** CREW (n) / TRANSCRIPTS
  tabs above dense rows — a status dot + name + short hash (minion rows
  lead with the heist's short name: the authored `display_name` when
  present, otherwise a display-only shortening of the title, plus a
  normally four-character id suffix extended only on same-heist
  collisions; full title and id stay in the row's tooltip and accessible
  name), a `role · state` subline (with turn age, supervision marks and
  runtime marks), and a right-aligned state chip; error rows carry the alert
  accent; disposed rows collapse behind a dashed `+N disposed` footer.
  Liveness is runtime ownership, not the raw stored state: each row
  carries a `runtime` classification — `current` (the live runtime owns
  it: registry handle, supervision adoption or a hydrated durable stop —
  a stopped/restarting lane stays current, and an owner-held stop keeps
  its live-crew row even after the released handle left the record
  `disposed`), `historical` (ownership probes are wired and no live
  runtime owns the record — a previous run or import left it; collapsed
  behind a `+N history` disclosure with transcripts intact, never
  counted or sorted as crew) or `unverified` (no ownership evidence —
  visible and explicitly marked, never guessed dead; on a classifying
  server an ambiguous row stays visible but is NOT claimed in the CREW
  count). A pre-upgrade server (no classification on any row) keeps the
  legacy attribution and counting. The chip reads the DERIVED `status`:
  a raw `idle` with an open supervision turn/control/tool call presents
  the work it is doing (`streaming`), and the quiet clock reads the newer
  of the ledger stamp and the supervision event stream. A duplicated
  CURRENT singleton-role owner (`gru`/`silas`/`bob`) is marked `⚠
  duplicate` — an anomaly surfaced, never silently discarded; a review
  pool (`perkins`) runs lead + specialists concurrently and never
  triggers the mark. The TRACKERS crew counts follow the same
  classification and derived status, so the strip and the rail cannot
  disagree. Clicking an agent with a session file opens its transcript.
  Supervision activity (open turn/control/tool calls) changes without a
  ledger event, so the board also refreshes every heartbeat interval —
  a connected rail can never stay stale. The silas chip is
  LIVE when `[silas] enabled` (default): the hosted ops session
  (`silas-ops` slot) appears there whenever its wake turns run, and its
  follow-through lands on the ledger as `silas.*` events
  (`silas.pr-registered`, `silas.review-triggered`,
  `silas.directive-sent`, `silas.rebrief`, `silas.escalated`,
  `silas.wake`) — visible in the event stream like every other
  transition.
- **Managed repository overview (owner-approved compact rows A):** below
  the CREW list, one read-only module per explicit name in root-level
  `managed_repos` (relative to `workspace_root`). The shared workspace root
  may contain unrelated repositories; installer discovery offers candidates
  but never enrolls siblings at runtime. An absent/empty list produces an
  empty overview with setup guidance. Each compact row shows the repository identity (an https
  link only when the origin remote proves a safe GitHub identity,
  otherwise an explicit not-linked reason), exact repo-wide open-PR and
  open-issue counts (issues EXCLUDING PRs, via GitHub's aggregate search;
  zero is a real count and unknown is never shown as zero), and the newest
  Actions run on the repository's discovered default branch as
  `workflow · branch` plus a status badge (passed/failed/timed-out/
  startup-failure/cancelled/skipped/neutral/action-required/stale-run/
  running/queued/no-workflow/never-run/no-branch/unknown; Actions-disabled
  rows read unavailable — text and glyph, never colour alone) with a
  safe run link and the checked age. This is default-branch CI context,
  never deployment health, aggregate CI or merge readiness. The server
  tracker refreshes every 5 minutes (bounded per-refresh call budget and
  wall-clock phases, search calls paced to the sustained quota, coalesced,
  server-side `gh` auth only; the browser never polls GitHub)
  and the row's `checkedAt` is the last SUCCESSFUL fetch: cached data kept
  after a failure or older than three cadences renders as `STALE · last …`
  with the age and the failure, so an old green never reads as current.
  The snapshot field is additive (`repoOverview`; absent/null hides the
  module). Rows live in their own bounded scroll list under the crew's
  independent scroll; the module follows the CREW tab and disappears with
  it on TRANSCRIPTS. Reads and disclosures are display-only — nothing
  here acks, executes or changes GitHub state.
- **Notification center (E7; routing split 2026-09-23; owner-attention
  registry 2026-10-11; section truth 2026-09-29):** the bell panel
  renders the durable notification log in three bands — FOR YOU (pending
  typed decisions, owner notices, proposals and ready PRs, even older
  than the bounded latest feed), NEEDS GRU (all pending machine rows,
  including those older than the recent feed; it wakes Gru once and
  refuses human Ack. Rows bound to a terminal merged/done/binned lane are
  CLOSED RECEIPTS: they render under FEED, never as live queue entries,
  and the live unacked chip does not count them), and FEED (FYI rows
  plus closed receipts). Route assignment is enforced server-side: only
  registered owner-reserved kinds can reach FOR YOU; a `needs-owner`
  request from any unregistered or machine kind is routed to Gru
  (action-required) and logged, and an unknown stop is triaged by Gru
  rather than dropped. Routine recovery (crash-loop breakers,
  provider-wall stops, re-brief/directive reconciliation) stays machine
  attention. Every card is the same readable shared component in both
  surfaces: mixed-case prose, a short metadata label, typed decision
  blocks and a Details disclosure holding the full diagnostics. The bell
  is the alert/history surface: it shares the SAME authoritative owner
  projection as the board's permanent FOR YOU band, so the two surfaces
  never disagree about what the owner owes (the badge and toasts still
  count needs-owner notifications only); opening it never completes an
  obligation. There is no timed escalation: machine alerts never promote
  to owner attention by age alone (docs/FLOW.md forbids promotion by age);
  a machine row leaves the queue when its producer resolves
  it, and only a concrete typed escalation (never a timer) places an owner
  decision in FOR YOU. The badge and live
  toasts serve needs-owner only; every displayed row earns a shown receipt
  per surface (a display receipt is not an acknowledgement). Owner
  decisions are recorded through the decision endpoint; owner notices
  carry no in-app control and clear when their producer resolves them on
  evidence. Informational owner stops earn the same unread badge as
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
(`demo-api`, `sample-site`, one live 9-lens round in mixed states) —
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

## Shared FOR GRU mailbox (GH-305)

The server's `mailbox` snapshot is the only FOR GRU membership authority.
Job threads aggregate exact-basis reasons (blocked/error, current review failure,
PR conflict, machine alerts and live obligations); unbound incidents have their
own rows. A concluded parent never hides a blocked child. The header separately
counts **threads**, **incidents**, and source **notifications**. Waiting and
delegated items remain inspectable with their owner, dependency, recheck,
control/follow-up references, restrictions and delivery receipt. Source job
statuses and child reports are never rewritten by mailbox reconciliation.

An absent mailbox means **unavailable**, not guessed eligibility or a clean
queue. FOR YOU, notification acknowledgements, and other bands keep their
existing authority. The mailbox is read-only on the board; disclosure does not
acknowledge or resolve anything.
