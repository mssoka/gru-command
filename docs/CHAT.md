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
| `user` | `text`, `client_msg_id` | a chat message; `client_msg_id` dedupes re-sends |

### Server → client

Every frame except the two fatal/ephemeral classes carries a monotonic
`seq` assigned from the durable frame log.

| Frame | Fields | Notes |
|---|---|---|
| `auth_ok` | `seq` | auth accepted; `seq` = the log high-water mark |
| `ack` | `client_msg_id`, `seq` | a user message was received (precedes any runtime work) |
| `user` | `text`, `client_msg_id`, `seq` | a message the writer sent — live to other clients, replayed on reconnect |
| `delta` | `text`, `seq` | streamed reply chunk |
| `tool` | `name`, `state: start\|end`, `seq` | live tool activity |
| `turn` | `state: start\|end`, `seq` | reply lifecycle |
| `error` | `message`, `fatal?`, `seq?` | see the error classes below |

The contract has no frames for thinking deltas or in-progress tool
updates: both are dropped at the socket boundary (transcript views own
those surfaces in a later epic).

## The seq invariant (load-bearing)

**Every seq-consuming frame is appended to the frame log before it is
sent, so the counter always equals the log's high-water mark.** Replay
arithmetic depends on it: `auth_ok.seq` is the high-water mark, and a
reconnecting client's replay ends exactly when the stream reaches it.
The log is append-only jsonl at `<data_dir>/chat/gru.frames.jsonl`;
seqs are exactly `1..N` consecutive. A log that violates this (a seq
gap, a non-frame line, a logged `auth_ok`) is corruption: the service
refuses to boot over it — history is never silently truncated. A torn
FINAL line (crash mid-append) is dropped with a warning, the one
survivable corruption shape.

## Auth

- First frame must be `auth` within 5 s (mock parity). Violations
  (`non-auth first frame`, `timeout`) get a fatal `error` then close.
- The token is `[auth].token` from the service config, compared via
  hashed constant-time equality. A bad token: fatal
  `unauthorized: bad token` then close.
- **Empty/absent token = closed door:** every connection gets a fatal
  `chat is not configured` error. There is no localhost bypass.
- A second `auth` on an authenticated socket is a non-fatal logged
  error (`already authenticated`); a malformed frame is a non-fatal
  logged error (`malformed frame`). The connection survives both.

## Error frame classes

| Class | `seq` | Logged | Replays to everyone | Used for |
|---|---|---|---|---|
| Fatal | no | no | no | bad/missing/late auth, chat not configured |
| Logged | yes | yes | yes | malformed frame, already-authenticated, runtime errors, delivery failures |
| Ephemeral | no | no | no | per-client policy notices: read-only rejection, spawn-failure notice |

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
the second's sends start working (pen promotion).

## Limits and notes

- Client messages are capped at 4 000 chars client-side; the server
  caps frame payloads at 64 KiB (a wedged client can't flood memory).
- Shutdown: the service closes chat clients first (1001 going away) so
  the UI queues before the runtime turns die; the next boot's
  boot-settle closes anything left open.
- v1 is LAN-only, no TLS. The token is the whole credential — treat it
  like one.
