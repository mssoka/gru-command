# UI — Gru Command web shell (E5 + E6)

The browser front-end: Playful Planet design system, app shell, the chat
view against the chat WebSocket, and (E6) the live board dashboard +
per-agent transcripts. Everything lives in `web/` (a npm workspace).
Framework-free vanilla TypeScript + Vite; the only runtime dependency is
`qrcode` (pairing screen). Board + transcript surfaces:
[BOARD.md](./BOARD.md).

## Runbook

```bash
npm install                 # clean clone: installs root + web workspace
npm test                    # lint + typecheck + backend build + all vitest
                            # (incl. the W5 LAN-phone raw-client suite)
npm run mock                # dev-only mock chat socket + board feed on :8787
npm run dev:web             # vite dev server on :5173 (proxies /ws +
                            # /board/ws + /api → mock)
npm run build:web           # production bundle → web/dist/ (no mock inside)
npm run e2e                 # playwright smoke (mock + real service, serial)
```

Open http://localhost:5173 and pair with the mock's default token
`dev-token` — typed, never prefilled (the UI never guesses a token). The
mock binds `127.0.0.1` by default and warns loudly while using that
development-only token. Its token is configurable via `GRU_MOCK_TOKEN`,
its port via `GRU_MOCK_PORT`, and its bind via `GRU_MOCK_HOST`. A
non-loopback mock bind is refused unless `GRU_MOCK_TOKEN` is explicitly
set to at least 16 characters.

> **Real socket (E5c, converged):** the UI now ships against the REAL
> `/ws` — see the [real-socket section](#real-socket-e5c) below. The mock
> remains the dev-only socket for `npm run dev:web` and the mock half of
> e2e.

## Design tokens (Playful Planet)

Defined in `web/src/styles/tokens.css`; components in
`web/src/styles/components.css`. Light is the default face; `.dark` on
`<html>` flips the set (manual toggle, persisted in `localStorage`
key `gru-theme`).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#faf6ef` | `#141a2b` | page background |
| `--card` | `#ffffff` | `#1c2438` | cards, nav |
| `--soft` | `#fdf8ee` | `#182033` | wells, composer, user bubbles |
| `--ink` | `#22304a` | `#e8ecf4` | primary text |
| `--line` | `#22304a` | `#313c58` | chunky outlines |
| `--muted` / `--faint` | `#6b7a94` / `#8a8678` | `#93a0b8` / `#6d7890` | secondary text |
| `--work` | `#ffd54a` | `#ffd54a` | minion yellow: working, Gru bubbles |
| `--done` | `#7ee08a` | `#6fd68a` | merged/done states |
| `--rev` | `#9ad7f5` | `#7cc4ef` | review states |
| `--park` | `#e8e3d8` | `#2a3350` | parked/vaulted |
| `--alert` | `#ffb3ba` | `#ff8f9c` | blocked/errors |
| `--perkins` | `#c9b8ff` | `#b7a3ff` | Perkins rounds |
| `--accent` | `#22304a` | `#ffd54a` | primary buttons |
| `--on-state` | `#22304a` | `#1a2236` | text ON saturated state colors |

Shape language: 2.5–3px ink outlines (`--outline*`), 14–22px radii,
hard offset shadows (`--shadow-card`, `--shadow-btn`), `--ease-pop`
springy bezier for micro-interactions.

Components: `.pp-card`, `.pp-soft`, `.pp-chip` (+ `--work/--done/--rev/
--alert/--park/--perkins` variants), `.pp-btn` (+ `--secondary`,
`--icon`), `.pp-row`, `.pp-input`, `.banner` (degraded modes),
`.msg--user` / `.msg--gru` chat bubbles, `.tool-line` status chips.

## Chat socket protocol (contract as built)

Endpoint `/ws`, JSON text frames. Shared source of truth:
`web/src/lib/protocol.ts` (types + validators). The mock
(`web/mock/server.ts`, **dev tooling only**) implements it exactly; the
real E4 socket will match.

Client → server:

| Frame | Fields | Notes |
|---|---|---|
| `auth` | `token`, `last_seen_seq?` | MUST be first; re-auth carries the high-water mark and receives fresh context state |
| `user` | `epoch`, `text`, `client_msg_id` | queued client-side while offline; server rejects a stale epoch before logging/delivery |
| `control` | `action: compact\|new_chat`, `request_id` | fixed writer-only controls; no free-form slash command |

Server → client (durable conversation frames carry a monotonic `seq`):

| Frame | Fields | Notes |
|---|---|---|
| `auth_ok` | `seq` | auth accepted; `seq` = log high-water mark |
| `ack` | `client_msg_id`, `seq` | a user message was received |
| `user` | `text`, `client_msg_id`, `seq` | restores own history on replay; the E4 server also broadcasts it live to other attached clients |
| `delta` | `text`, `seq` | streamed reply chunk |
| `tool` | `name`, `state: start\|end`, `seq` | live tool status line |
| `turn` | `state: start\|end`, `seq` | reply lifecycle |
| `error` | `message`, `fatal?`, `seq?` | fatal → socket closes (bad token) |
| `context` | `epoch`, `replay_floor_seq`, `state`, `usage`, capability/session/writer flags | fresh ephemeral control state; provider usage or explicit unavailable |
| `control_result` | action/request id, `ok`, `epoch`, failure details | ephemeral correlated terminal result; never replayed as chat |
| `context_event` | action, `ok`, optional bounded message | ephemeral broadcast outcome for provider compaction or post-commit supervision degradation |

**Reconnect:** re-auth with `last_seen_seq`; server sends `auth_ok`, a
fresh `context`, then replays logged frames above both the client seq and
the durable replay floor. An epoch advance clears only the active visible
history and sent/acked messages; browser-local never-sent outbox words are
atomically restamped and flushed after the new snapshot. A tab-local
pending-reset marker suppresses retired replay across reload until an
idle snapshot proves commit or rollback. The client dedupes by
`seq`/`client_msg_id` within the active epoch.

**Mock control plane (tests):** token-authenticated `POST /__reset` on
the mock port clears the frame log and sequence — keeps e2e snapshots
hermetic. Token-authenticated `POST /__drop` terminates every connected
socket — drives degraded-mode e2e.

**Client guards:** messages are capped at 4 000 chars (`MAX_MESSAGE_CHARS`,
mirrored by the composer's `maxlength`); a socket that never finishes
handshaking is abandoned after 10 s; a server whose `auth_ok.seq`
arrives below the client's high-water mark (truncated store) triggers an
automatic full-replay resync.

**E4 status:** transport-level heartbeats landed with the real socket
(ws ping/pong, two unanswered pongs terminate — no JSON-contract
frames, see [CHAT.md](./CHAT.md)). The pairing token still persists
indefinitely in `localStorage` (`gru-pairing-token`) — lifetime/rotation
belongs to the E9 token flow.

**Typed-word recovery in the active tab:** unacked messages persist in
tab-scoped `sessionStorage` (`gru-outbox`, id + epoch + text + chips), survive
ordinary reload/reconnect, render as queued bubbles, and flush in order after
re-auth; replay ends exactly when the stream reaches the `auth_ok` high-water
mark. Initial persistence failure rejects send so the composer keeps its
text/chips. Later storage failure keeps the in-memory queue and surfaces the
failure, but site-data clearing, browser eviction, or catastrophic storage loss
can still remove it; this is not server-side message durability.

## The composer attach flow (SPEC ruling 19)

The composer carries an attach button (📎) — the ONE flow for bringing
material into a conversation. **The user never types or pastes paths.**

- **On-disk files:** the button opens a picker that browses the
  service's workspace root (the canonical namespace) over
  `/api/attach/browse` — directories navigate, files pick. The picked
  file becomes a ready-to-send chip carrying its ABSOLUTE path; no
  bytes ever move (no byte copy). Out-of-workspace symlink targets are
  shown disabled. Listings say when only the first 500 entries are
  shown, and a late response cannot overwrite newer navigation.
- **Device files (phone camera/gallery, desktop picks):** "📁 from this
  device…" opens the browser's real file chooser; bytes POST to
  `/api/attach/uploads` and MATERIALIZE into `<data_dir>/uploads/`; the
  chip carries that path. The UI rejects a file over 8 MiB from its
  metadata **before reading it into memory**.
- **Clipboard paste:** pasting a file/image into the composer
  materializes it the same way (Mac-screenshot class).
- **Chips:** ready-to-send pills above the input (🖼️ image / 📎 file,
  ✕ removes); they ride the `user` frame, render on the sent bubble,
  and replay with history. An attachment-only send (no typed text) is
  legal. Cap: 8 chips per message.
- The picker closes on pick, ✕, or Escape; upload failures surface as
  ephemeral in-log notices (never modal). Device uploads cap at 8 MiB
  per file and 8 chips per message; sending holds until **every** upload
  gesture settles, including concurrent files with the same name
  (nothing slips silently into a later message).
- Attach requests time out after 10 s — a hung service surfaces as the
  picker's inline error, never a stuck "browsing…" state.
- History replay (chips included) is bounded by the chat frame log's
  rotation window (3 × 8 MB shards) — the same bound every message
  shares.

## Message rendering (GFM contract — issue #10)

**USER CANON: users must never see raw markdown output** — especially
when chatting with Gru. Assistant replies render through the GFM-subset
renderer (`web/src/lib/markdown.ts`, wired into the existing chat delta
path in `web/src/ui/chat.ts`); user messages stay plain text.

| Construct | Behavior |
|---|---|
| Headers (`#`…`######`) | real `h1`–`h6` elements, scaled for bubble context |
| GFM tables | real `<table>` with `thead`/`tbody`; `:--:` alignments honored; `\|` escapes; header-only rows (separator still streaming) still render as a table |
| Fenced code (``` and ~~~) | `<pre class="md-code"><code>` + language label; unclosed fences render as a growing block |
| Lists | ordered/unordered, nesting by indentation |
| Blockquotes, `---` rules | bordered quote, `<hr>` |
| Inline | `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[links](https://…)` |
| Links | only `http(s):`, `mailto:`, and site-relative hrefs are linkable; other schemes render as literal text. Images render as labelled links (no remote loading in v1) |
| Raw HTML | NEVER parsed — displayed literally. The renderer builds DOM via `textContent`/`createTextNode` only (no `innerHTML` anywhere), so XSS-safety is structural |
| Emoji | Unicode passthrough |

**Streaming safety:** each delta re-renders the accumulated reply atomically
(`replaceChildren` — one paint per delta, no flicker). Incomplete constructs
hold stable: an open fence grows as a code block, a table streams row by
row, and a trailing partial marker (1–2 backticks, a bare `#`, a growing
`---`) is held back until more deltas arrive or the turn ends (turn end
re-renders once in final mode). Soft newlines inside paragraphs render as
`<br>` (chat convention).

**The invariant gate (hard v1 acceptance):**
`web/src/ui/chat-gfm-invariant.test.ts` streams a Gru reply containing a
table + code block through the real `ChatView.addFrame` path and FAILS if
raw pipes/fences reach the DOM — asserted at every streaming prefix, not
just at rest. Mutation-proven: disabling the renderer (raw text-node path)
turns the gate red (both delta-only and full disable — run the mutation
yourself when touching the renderer; the recipe is in the test header).
Renderer construct coverage is pinned in `web/src/lib/markdown.test.ts`.

**Boundary:** the E6 transcript drawer (`web/src/ui/transcript.ts`) still
shows entry text as plain text — a different surface; GFM there is a
follow-up lane, not part of this contract.

## Views

- **Pairing** — token field + QR (encodes `{url, token}` JSON payload
  built from `location.origin` + the typed token — the real payload
  against the served UI; the wizard's token generation arrives with E9).
  Bad token → inline error. The field starts EMPTY everywhere — mock or
  real, localhost or LAN — the token is per-install, never a guess.
- **Chat** — desktop: panel (default tab); mobile (≤768px): corner
  bubble that opens a bottom sheet (same DOM reparented via matchMedia;
  unread badge counts deltas arriving while closed). Gru replies render as
  GFM markdown (see the [rendering contract](#message-rendering-gfm-contract--issue-10));
  streaming deltas re-render token-by-token with a caret; tool activity is
  a live status line. User messages stay plain text. A quiet row above the
  composer shows provider context percent (or explicit unavailable),
  **Compact context**, and **New chat**. Busy/read-only/unsupported states
  disable the relevant controls. New chat uses native confirmation and
  immediately opens an empty pending-reset view, persisted per tab across
  reload; a pre-commit failure restores the retired render model, while a
  durable epoch finalizes the empty view. Words entered while reset is pending
  stay visible and are sent once to the authoritative winning epoch.
  Compact success/failure and unsolicited provider outcomes are announced in
  a dedicated persistent live region that idle usage refreshes cannot erase.
- **Board (E6)** — desktop tab `🗺️ Board`: repo-grouped job cards, round
  rows with 7 per-lens live chips, agent rail, transcripts list,
  notification center (see [BOARD.md](./BOARD.md)). **Phone:
  board-first** (SPEC ruling 11) — the board is the landing view, chat
  stays one tap away via the bubble; the Chat tab opens the sheet.
- **Transcripts (E6)** — drawer from the agent rail / transcripts list:
  newest-first paging, server-side search with jump-to-entry, wrap
  toggle (long lines unwrap, never clip), collapsed thinking.
- **Degraded modes** — banners for connecting/reconnecting/offline; the
  nav dot mirrors socket state (open/busy/down).
- **Settings stub** — theme toggle, socket endpoint, unpair. Grows with
  E7/E9.

## Tests

- Unit (`npm run test:web`, vitest): protocol validators, theme
  fallback, chat-client contract tests against an in-test WS server
  (send/ack, offline queue, reload survival, reconnect replay dedup,
  bad-token fatal, malformed frames), the GFM markdown renderer suite,
  and the raw-markdown invariant gate (issue #10 — happy-dom DOM tests).
- E2E (`npm run e2e`, Playwright, serial, two projects):
  - **mock** — the dev-only mock via vite preview: pair → chat → streamed
    reply, reload keeps history, socket-drop recovery, mobile sheet,
    theme snapshots (committed under `web/e2e/smoke.spec.ts-snapshots/`).
  - **real** — the REAL service (`test/helpers/real-service.mjs` boots
    `dist/main.js` with a real token config and the offline claude CLI
    double as the Gru runtime): pair with the real token, streamed echo
    reply, reload + service-restart reconnect keeps history and flushes
    the typed word, mobile sheet + unread badge, wrong-token fatal,
    theme snapshots (`web/e2e/real-server.spec.ts-snapshots/`).
  Uses the Playwright chromium already installed on the dev machine
  (`@playwright/test` 1.58 ↔ chromium-1208); on machines without it,
  `npx playwright install chromium` once.

## Real socket (E5c)

E5 shipped against the mock; E4 landed the real `/ws`; E5c converged
them. The UI's socket wiring was already target-agnostic — the client
builds `ws(s)://location.host/ws` and the service serves both the built
UI and the socket on one port, so the flip needed **zero client rewiring**.

**What changed:**

- The pairing token field no longer prefills `dev-token` on localhost —
  that mock convenience leaked the WRONG token into every real install
  browsed from localhost. Devs against the mock type `dev-token` once.
- e2e grew the `real` project (above) alongside the kept-green mock
  smoke; the reconnect case is a REAL service restart (the real server
  has no test control plane, and network emulation does not cut loopback
  sockets) — which also proves durable-history-across-restart.
- `test/lan-phone-raw-client.test.ts` (W5): raw `ws` clients walk the
  phone-shaped flow against the real token flow — full replay on pair,
  read-only while another client holds the pen, silent pen promotion,
  send-after-promotion, incremental `last_seen_seq` catch-up.

**What stayed:**

- The frame contract is one source of truth (`web/src/lib/protocol.ts`);
  the corpus parity test (`test/chat-frames.test.ts`) still fails on any
  divergence in either direction.
- The mock stays as dev tooling (`npm run dev:web`, mock e2e half) —
  validated against the real server, not replaced.
- All client behavior (outbox, dedup by `seq`/`client_msg_id`, resync on
  truncated stores, degraded banners) is unchanged and now proven
  against the real socket.

**Running against a real service locally:** `npm run build &&
npm run build:web && npm start`, then open `http://localhost:7665` and
pair with the `[auth] token` from your `config.toml` (see
[CONFIG.md](./CONFIG.md)); set `[server] host` to the machine's LAN
address to pair a phone — the QR on an already-paired device carries the
real payload.
