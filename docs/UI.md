# UI — Gru Command web shell (E5)

The browser front-end: Playful Planet design system, app shell, and the
chat view against the chat WebSocket. Everything lives in `web/` (a npm
workspace). Framework-free vanilla TypeScript + Vite; the only runtime
dependency is `qrcode` (pairing screen).

## Runbook

```bash
npm install                 # clean clone: installs root + web workspace
npm test                    # lint + typecheck + backend build + all vitest
npm run mock                # dev-only mock chat socket on :8787
npm run dev:web             # vite dev server on :5173 (proxies /ws → mock)
npm run build:web           # production bundle → web/dist/ (no mock inside)
npm run e2e                 # playwright smoke (mock + vite preview, serial)
```

Open http://localhost:5173 and pair with the mock's default token
`dev-token` (prefilled automatically on localhost). The mock token is
configurable via `GRU_MOCK_TOKEN`; its port via `GRU_MOCK_PORT`.

> **Integration note (E4 follow-up):** the UI talks to the mock socket
> until E4's real chat API lands. Production static-serving and the real
> pairing-token QR wire into the service then — deliberately NOT in this
> PR (the frontend lane touches only `web/` + build plumbing).

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
| `auth` | `token`, `last_seen_seq?` | MUST be first; re-auth carries the high-water mark |
| `user` | `text`, `client_msg_id` | queued client-side while offline |

Server → client (every frame carries a monotonic `seq`):

| Frame | Fields | Notes |
|---|---|---|
| `auth_ok` | `seq` | auth accepted; `seq` = log high-water mark |
| `ack` | `client_msg_id`, `seq` | a user message was received |
| `user` | `text`, `client_msg_id`, `seq` | replay only — restores own history |
| `delta` | `text`, `seq` | streamed reply chunk |
| `tool` | `name`, `state: start\|end`, `seq` | live tool status line |
| `turn` | `state: start\|end`, `seq` | reply lifecycle |
| `error` | `message`, `fatal?`, `seq?` | fatal → socket closes (bad token) |

**Reconnect:** re-auth with `last_seen_seq`; server sends `auth_ok` then
replays every logged frame with `seq > last_seen_seq` in order, then
resumes live. Omitting `last_seen_seq` (fresh page load) replays
everything. The client dedupes by `seq`/`client_msg_id`; re-sent user
frames (unacked across a drop) are deduped server-side and re-acked.

**Mock control plane (tests):** `POST /__reset` on the mock port clears
the frame log and sequence — keeps e2e snapshots hermetic.

**Never lose a typed word:** unacked messages persist in `localStorage`
(`gru-outbox`, id + text), render as queued bubbles, and flush in order
after re-auth; replay ends exactly when the stream reaches the
`auth_ok` high-water mark.

## Views

- **Pairing** — token field + QR (encodes `{url, token}` JSON payload;
  mock payload until E4/E9 wire the real one). Bad token → inline error.
- **Chat** — desktop: panel; mobile (≤768px): corner bubble that opens a
  bottom sheet (same DOM reparented via matchMedia; unread badge counts
  deltas arriving while closed). Streaming deltas render token-by-token
  with a caret; tool activity is a live status line.
- **Degraded modes** — banners for connecting/reconnecting/offline; the
  nav dot mirrors socket state (open/busy/down).
- **Settings stub** — theme toggle, socket endpoint, unpair. Grows with
  E6/E7.

## Tests

- Unit (`npm run test:web`, vitest): protocol validators, theme
  fallback, and chat-client contract tests against an in-test WS server
  (send/ack, offline queue, reload survival, reconnect replay dedup,
  bad-token fatal, malformed frames).
- E2E (`npm run e2e`, Playwright, serial): pair → chat → streamed reply,
  reload keeps history without duplicates, mobile bubble/sheet + unread
  badge, light+dark theme snapshots (committed under
  `web/e2e/smoke.spec.ts-snapshots/`). Uses the Playwright chromium
  already installed on the dev machine (`@playwright/test` 1.58 ↔
  chromium-1208); on machines without it, `npx playwright install
  chromium` once.
