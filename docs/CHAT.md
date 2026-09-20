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
| `control` | `action: compact\|new_chat`, `request_id` | fixed product controls only; writer-only and accepted only while the chat is idle |

### Server → client

Durable conversation frames carry a monotonic `seq` assigned from the
frame log. Fresh `context` snapshots and `control_result` replies are
explicitly ephemeral: they are never logged or replayed.

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
| `context` | `epoch`, `replay_floor_seq`, `state: idle\|busy\|compacting\|resetting`, `usage`, `compact_supported`, `session_active`, `writer` | fresh server-owned snapshot after auth and on every control/writer/runtime-state transition. `usage` is provider-owned or `null`, never a frontend estimate |
| `control_result` | `action`, `request_id`, `ok`, `epoch`, `code?`, `message?` | terminal result for exactly one request; failures distinguish `busy`, `unsupported`, `read_only`, `no_session`, and runtime/persistence `failed` |

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
the earliest authenticated reader (FIFO). Clients receive a fresh
`context` snapshot reflecting the promotion. Transport heartbeats
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

## Context usage, Compact, and New chat

The context row is a control/status surface, not chat content. Pi reports
native `getContextUsage()` values while idle; Claude print mode does not
expose a trustworthy whole-context measure, so it reports unavailable.
No adapter or UI reconstructs usage from streamed deltas.

- **Compact context** invokes the active provider's native control in the
  same session. Pi uses its SDK compactor; Claude executes a dedicated
  resumed machine-output `/compact` process and suppresses every command
  output frame from chat. The session id/file must remain unchanged.
  Visible chat messages are not removed. Failure is terminal and bounded,
  and the old conversation remains usable.
- **New chat** is destructive only to the active view/context: after a
  native confirmation, the server mints without resume/transcript/summary,
  activates the durable epoch boundary, and publishes a fresh snapshot.
  It does not fake reset by clearing DOM or sending prose to the model.
- Controls serialize against turns, runtime spawning, one another, and
  queued deliveries. Supervisor restarts are coordinated by slot generation:
  an intentional fresh replacement wins and any stale completion is disposed.
  Busy attempts are rejected rather than guessed.
  Non-writer tabs remain read-only. Context usage is unavailable during
  compaction/reset until the provider can supply fresh data.

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
  `auth_ok` (high-water), a fresh `context` snapshot, then every logged
  frame with `seq > max(last_seen_seq, replay_floor_seq)` in order, then
  live traffic. The browser clears the active view only after observing
  an advanced durable epoch. Sent/acked messages from the retired epoch
  are dropped; never-sent local outbox words survive and flush into the
  new epoch.
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
- **The Gru brain:** the active session file, chat `epoch`, and
  `replayFloorSeq` are recorded together at
  `<data_dir>/chat/gru-session.json` (atomic writes; legacy files default
  both numbers to zero). On boot the chat server resumes THAT session.
  **New chat** first mints an unresumed native session, then atomically
  advances all three fields and swaps the supervised slot; any failure
  before activation leaves the old session/epoch usable. New chat never
  deletes or rewrites old native transcripts or frame-log bytes, and a
  second reset simply advances the boundary again. Frame shards remain
  subject only to the configured size/retention policy described in
  `SUPERVISION.md`; a reset itself does not rotate or prune them.

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
- The official browser does not transmit while its authoritative context
  says `writer:false`; words stay queued locally and flush after pen
  promotion. Raw/third-party clients that send anyway receive an ephemeral
  read-only rejection and must decide whether to retry.
- Shutdown: the service closes chat clients first (1001 going away) so
  the UI queues before the runtime turns die; the next boot's
  boot-settle closes anything left open.
- v1 is LAN-only, no TLS. The token is the whole credential — treat it
  like one.
