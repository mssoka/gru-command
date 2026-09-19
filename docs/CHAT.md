# CHAT — the single-Gru socket protocol and reconnect contract (E4)

The chat surface: one WebSocket endpoint on the service's HTTP port,
fronting exactly one Gru agent session (SPEC ruling 1 — single Gru,
single writer). The browser UI is a window onto that brain, never a
second one.

- **Contract source of truth (frame shapes + validators):**
  [`web/src/lib/protocol.ts`](../web/src/lib/protocol.ts) — built and
  mutation-proven with the web UI. The server mirrors it exactly; a
  corpus parity test (`test/chat-frames.test.ts`) fails on any
  divergence in either direction.
- **Client-side behavior** (outbox, dedup, resync, banners):
  [UI.md](./UI.md). This document is the server side.

## Endpoint and framing

`ws://<server.host>:<server.port>/ws` — JSON text frames both
directions. The same port serves the built web UI (`web/dist`) and
`/health`, so the frontend's `location.host` wiring needs zero
configuration in production.

### Client → server

| Frame | Fields | Notes |
|---|---|---|
| `auth` | `token`, `last_seen_seq?` | MUST be the first frame, within 5 s of connect |
| `user` | `text`, `client_msg_id`, `attachments?` | a chat message; `client_msg_id` dedupes re-sends. `attachments` (SPEC ruling 19): 1–8 chips `{path, name, kind: file\|image}` — PATH references from the one attach flow; an attachment-only frame (empty `text` + chips) is legal, a frame with neither is malformed |

### Server → client

Every frame except the two fatal/ephemeral classes carries a monotonic
`seq` assigned from the durable frame log.

| Frame | Fields | Notes |
|---|---|---|
| `auth_ok` | `seq` | auth accepted; `seq` = the log high-water mark |
| `ack` | `client_msg_id`, `seq` | a user message was received (precedes any runtime work) |
| `user` | `text`, `client_msg_id`, `attachments?`, `seq` | a message the writer sent — live to other clients, replayed on reconnect (chips replay with it) |
| `delta` | `text`, `seq` | streamed reply chunk |
| `tool` | `name`, `state: start\|end`, `seq` | live tool activity |
| `turn` | `state: start\|end`, `seq` | reply lifecycle |
| `notice` | `text`, `seq` | product notice surfaced in chat (E7, SPEC ruling 13): action-required notifications ("⚠ Action required: …") and supervisor restart notices. Logged + replayed; never fatal, never a turn |
| `error` | `message`, `fatal?`, `seq?` | see the error classes below |

The contract has no frames for thinking deltas or in-progress tool
updates: both are dropped at the socket boundary (transcript views own
those surfaces in a later epic).

## Attachments (SPEC ruling 19 — the ONE attach flow)

Exactly one flow brings non-repo material into a conversation, and it
resolves to PATHS, never pasted bytes:

- **On-disk picks** browse the workspace root over
  `GET /api/attach/browse?path=<rel>` (token-authed, metadata only —
  no file bytes ever move) and send the picked file's absolute path.
  **No byte copy**: the source file is referenced where it lies. Listings
  cap at 500 entries and return `truncated: true`; entries whose symlink
  target escapes the canonical workspace return `pickable: false`.
- **Clipboard paste and phone-origin content** materialize over
  `POST /api/attach/uploads` (JSON `{filename, content_base64}`) into
  `<data_dir>/uploads/` (0700; hardened at boot and on every write)
  and send THAT path. An upload is capped at 8 MiB; the directory is
  capped at 1,000 files. Those limits return HTTP 413 and 507,
  respectively. Names are bounded by UTF-8 bytes and collisions never
  overwrite an earlier upload.
- **Delivery** composes the chips into the prompt as a path manifest
  (`[attached files — read them yourself at these paths]`) — the agent
  always receives paths and reads the files itself. No image bytes ride
  the prompt in this flow.
- **Vision gating**: each spawned handle projects `images` from the
  **resolved model's declared input types**, not from a runtime-wide
  constant. An `image` chip on a handle whose resolved model does not
  declare image input DECLINES GRACEFULLY — the paths still deliver, a
  logged `notice` tells the user vision is unavailable, and the prompt
  instructs the agent never to guess at image contents. Missing model
  metadata is conservative (`images: false`). Never an error frame,
  never a silent drop.
- ONE seam (`/api/attach/*`) serves every surface: the chat composer
  rides it today; the dispatch surface rides the same endpoints when its
  composer lands — no per-surface side doors exist.
- **Chip-path provenance**: the delivery layer realpaths each chip and
  only workspace-root or uploads-dir paths reach the agent's manifest —
  anything else drops GRACEFULLY (a logged notice names the rejected
  path). If validation rejects every chip and the typed text is empty,
  the frame remains acknowledged and noticed but no empty prompt is
  delivered to the agent.

## The seq invariant (load-bearing)

**Every seq-consuming frame is appended to the frame log before it is
sent, so the counter always equals the log's high-water mark.** Replay
arithmetic depends on it: `auth_ok.seq` is the high-water mark, and a
reconnecting client's replay ends exactly when the stream reaches it.
The log is append-only jsonl at `<data_dir>/chat/gru.frames.jsonl`;
seqs are exactly `1..N` consecutive. A log that violates this (a seq
gap, a non-frame line, a logged `auth_ok`, a persisted `fatal` frame)
is corruption: the service refuses to boot over it — history is never
silently truncated. A torn FINAL line (crash mid-append) is dropped
with a warning, and a parseable final line missing only its newline is
repaired in place (newline-terminated) — the two survivable crash
tails. The writer is held to the same rule from the other side:
`append()` refuses any frame `load()` would reject.

## Auth

- First frame must be `auth` within 5 s (mock parity). Violations
  (`non-auth first frame`, `timeout`) get a fatal `error` then close.
- The token is `[auth].token` from the service config, compared via
  hashed constant-time equality. A bad token: fatal
  `unauthorized: bad token` then close.
- **Empty/absent token = closed door:** every connection gets a fatal
  `chat is not configured` error. There is no localhost bypass.
- A second `auth` on an authenticated socket is a non-fatal logged
  error (`already authenticated`); a malformed frame from an
  authenticated socket is a non-fatal logged error (`malformed frame`).
  Pre-auth malformed frames get the same client-visible error but are
  ephemeral — an unauthenticated socket never writes durable history.
  The connection survives all of these; the auth deadline still bounds
  the pre-auth window.

## Error frame classes

| Class | `seq` | Logged | Replays to everyone | Used for |
|---|---|---|---|---|
| Fatal | no | never | no | bad/missing/late auth, chat not configured — the only frames that ever carry `fatal: true`, and they are never persisted |
| Logged | yes | yes | yes | malformed frame (authenticated sockets), already-authenticated, runtime errors + delivery failures — **never `fatal: true`**: the shipped client treats any replayed fatal frame as pairing-fatal, so a logged runtime death must read as history, not poison |
| Ephemeral | no | no | no | per-client policy notices: read-only rejection, spawn-failure notice, malformed frame before auth |

Ephemeral frames are for conditions that are expected policy (not
malfunctions) and must not pollute permanent history for every future
reader.

## Single writer

Exactly one client holds the pen: the first authenticated client. Other
concurrently attached clients are **read-only** — they receive
`auth_ok`, the replay, and every live broadcast, but their `user`
frames are rejected with an ephemeral `read-only` error (nothing is
logged or delivered). When the writer disconnects, the pen promotes to
the earliest authenticated reader (FIFO). Promotion sends no frame — a
promoted client simply finds its sends working. Transport heartbeats
(ws ping/pong every 30 s; two misses terminate) ensure a silently dead
socket releases the pen.

## Turns: prompt, steer, and the runtime boundary

The chat layer drives the `AgentRuntime` interface only — it never
touches a concrete adapter. A `user` frame when no turn is live becomes
`prompt(text)`; a `user` frame during a live turn becomes `steer(text)`
— native mid-turn steering on runtimes that support it, serialized
delivery-after-idle on runtimes that don't (the E2 fallback wrapper).
All chat deliveries share one owner identity (the single user), so the
adapter-level single-writer queue never fragments the conversation.

Runtime events map to frames: `turn_start/end` → `turn`,
`text_delta` → `delta`, `tool_start/end` → `tool` (the server tracks
call ids so the `end` carries the same tool name). A **fatal runtime
error mid-turn** is logged as an `error` frame, then the turn is
settled immediately: open tools end (reverse order), the turn ends —
history always reads "the turn died here," never an open stream.

## Reconnect and never-lose-a-typed-word

- The client queues unacked messages locally (its outbox) and re-sends
  them after re-auth; the server `ack`s every received `user` frame
  BEFORE any runtime work, and dedupes re-received frames by
  `client_msg_id` — a re-send gets a fresh `ack`, never a re-delivery,
  never a duplicate `user` frame.
- A message whose RUNTIME delivery fails (spawn outage, disposed
  session) stays acked and logged with an error frame recording the
  failure — there is no automatic redelivery; re-send it. The typed word
  is never silently lost, and neither is the failure.
- Reconnecting clients re-auth with `last_seen_seq`; the server sends
  `auth_ok` (high-water), then every logged frame with
  `seq > last_seen_seq` in order, then live traffic. No
  `last_seen_seq` (fresh page) replays everything, restoring both sides
  of the conversation.
- Live frames emitted during a client's replay have seqs above the
  high-water mark and arrive after the replay by per-socket FIFO —
  gapless by the seq invariant.

## Durability across restarts

- **Frame log:** survives restarts by construction (append-only,
  synchronous writes — durable across process death via the OS page
  cache; a power-loss window remains, accepted for v1). If the process
  dies mid-append, the torn final line is dropped with a warning and
  the file is repaired to the valid prefix at the next boot. If it dies
  mid-turn, the log ends with an open turn — at boot, before any client
  attaches, the server appends the closing frames (open tools end in
  reverse order, then `turn end`). This is the mock's aborted-turn rule,
  moved to the one place a real multi-client server can see it.
- **The Gru brain:** the active session file is recorded at
  `<data_dir>/chat/gru-session.json` (atomic writes). On boot the chat
  server resumes THAT session via the runtime (`resumeFile`) — the same
  brain, never a fork. A pointer naming a vanished file spawns fresh
  with a warning (the history is gone either way); a corrupt pointer or
  a resume error fails loud.
- Log rotation (frame log and `service.log` alike) is deferred to the
  supervision epic by prior review ruling.

## Pairing, static UI, and the LAN phone flow

The service serves the built web UI from `web/dist` on the same port
(`npm run build:web`; absent dist → the old JSON 404, dev uses Vite).
The pairing screen's QR encodes `{"gru-command":1, url, token}` built
fully client-side from `location.origin` + the typed token — against
the real service this IS the real payload, no server endpoint needed.
To pair a phone: bind `server.host` to the machine's LAN address, open
`http://<lan-address>:<port>` on the phone, enter the token (or scan
the QR shown on an already-paired device). Real-socket exercise: pair a
second device (or a second browser profile) and confirm it attaches
read-only while the first holds the pen; close the first and confirm
the second's sends start working (pen promotion). The automated
equivalent (W5, closed with E5c): `test/lan-phone-raw-client.test.ts`
walks this exact flow with raw `ws` clients against the real service —
full replay on pair, read-only rejection (ephemeral, unlogged), silent
pen promotion, send-after-promotion, and incremental `last_seen_seq`
catch-up.

## Limits and notes

- Client messages are capped at 4 000 chars client-side; the server
  caps frame payloads at 64 KiB (a wedged client can't flood memory).
- A message rejected as read-only is NOT re-delivered when its client
  is later promoted — the sender re-sends it (the UI keeps it in the
  outbox only while unacked; a read-only rejection leaves it sent).
- Shutdown: the service closes chat clients first (1001 going away) so
  the UI queues before the runtime turns die; the next boot's
  boot-settle closes anything left open.
- v1 is LAN-only, no TLS. The token is the whole credential — treat it
  like one.
