# Gru Command

A standalone, installable multi-agent orchestrator: one service hosting
every agent as a headless session behind a pluggable runtime adapter, with
a web front-end for chat, the live job board, and per-agent transcripts.

> **Status: early build.** Through the supervision epic: chat with the
> single Gru, the SQLite ledger of record, the live board dashboard with
> per-agent transcripts, in-process supervision (restart ladders +
> crash-loop breakers), the notification system with acks, and OS service
> install (launchd/systemd). Dispatch flow and the setup wizard land in
> the coming epics (see [docs/EPICS.md](docs/EPICS.md)).

## Quickstart (development)

```bash
npm install
npm test        # lint + typecheck + build + full test suite
npm start       # serve GET /health on 127.0.0.1:7665 — requires dist/ from npm test/build; run `npm run build` first if you skipped both
```

Configuration reference: [docs/CONFIG.md](docs/CONFIG.md) · chat
contract: [docs/CHAT.md](docs/CHAT.md) · ledger:
[docs/LEDGER.md](docs/LEDGER.md) · board + transcripts:
[docs/BOARD.md](docs/BOARD.md) · supervision + notifications + OS
service install: [docs/SUPERVISION.md](docs/SUPERVISION.md).

Run it as a login-started OS service:

```bash
npm install && npm run build && ./install.sh
```

## License

MIT — see [LICENSE](LICENSE).
