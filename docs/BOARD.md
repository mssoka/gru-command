# Board — the live dashboard (E6)

The board is the product's flagship window: repo-grouped job cards with
state chips, review rounds with per-lens live chips, the agent rail
(the standing crew), the notification center, and per-agent transcript
views — all fed live from the ledger through the event bus. The browser
is the only required window; the board is read-only by design (dispatch
authorship UI lands with E8).

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
| `POST /api/notifications/:id/ack` | `{by?}` — human ack; clears the row and re-arms an open breaker |
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

- **Desktop:** nav tabs `💬 Chat` (default) / `🗺️ Board`. Board = repo
  cards (title, status chip, note, PR link) + round rows with per-lens
  chips (`○ pending` gray · `◉ live` yellow · `✓ done` green · `✕ error`
  red) + agent rail + transcripts list + notification bell.
- **Phone (≤768 px):** board-first (SPEC ruling 11) — chat stays one tap
  away via the existing corner bubble → bottom sheet; the Chat tab opens
  the sheet.
- **Agent rail:** every ledger agent with a live state chip (🧠 gru ·
  📋 silas · 🔧 minion · 🔍 perkins · 🌙 bob); clicking an agent with a
  session file opens its transcript.
- **Notification center (E7):** the bell panel renders the durable
  notification log — FYI rows (blocked jobs, errored agents/lenses,
  verdicts, supervisor events) and action-required rows (crash-loop
  breaker trips) with ack buttons. The badge counts unseen errors; every
  displayed row earns a shown receipt (nothing "shown" without an ack
  record); acking an action-required row clears it and re-arms an open
  breaker. Live arrivals toast (plus a browser notification when
  permission was granted).
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
  board (API-seeded jobs, live push, agent rail, real transcript open +
  search, 401 doors, phone board-first).
