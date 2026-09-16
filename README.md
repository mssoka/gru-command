# Gru Command

A standalone, installable multi-agent orchestrator: one service hosting
every agent as a headless session behind a pluggable runtime adapter, with
a web front-end for chat, the live job board, and per-agent transcripts.

> **Status: early build.** Foundation epic only — config system, service
> skeleton, and health endpoint. Runtimes, UI, and the installer land in
> the coming epics (see [docs/EPICS.md](docs/EPICS.md)).

## Quickstart (development)

```bash
npm install
npm test        # lint + typecheck + build + full test suite
npm start       # serve GET /health on 127.0.0.1:7665 (config: ~/.gru-command/config.toml)
```

Configuration reference: [docs/CONFIG.md](docs/CONFIG.md).

## License

MIT — see [LICENSE](LICENSE).
