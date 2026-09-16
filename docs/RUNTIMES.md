# Runtime adapters

Gru Command hosts every agent session behind the `AgentRuntime` interface
(`src/runtime/types.ts`). Nothing above the adapter layer may import a
concrete adapter — the interface is the contract (SPEC ruling 4).

## Capability matrix

| Capability | `pi` | Meaning |
|---|---|---|
| `streaming` | ✅ | text/thinking deltas emitted live |
| `steer` | `native` | mid-turn steering delivered to the live turn |
| `resume` | `file` | sessions resume from durable jsonl |
| `images` | ✅ | image content accepted in prompts |
| `thinking` | ✅ | thinking output surfaced as events |
| `thinkingLevelControl` | ✅ | thinking level settable per spawn |
| `followUp` | ✅ | native queue-until-idle for the turn owner |

(`claude-code` lands in the next epic; its row ships with its adapter.)

## Model & thinking level policy (SPEC ruling 16)

- **Default = the runtime harness's own configuration.** The sentinel
  `model = "default"` (or an empty value) means "whatever pi / Claude Code
  is themselves configured to use" — the product never hardcodes a model.
- Explicit overrides are `"provider/model"` strings (pi) validated
  **fail-loud** at spawn: an unresolvable reference is an error naming the
  reference, never a silent fallback.
- Thinking levels: `"default"` passes through; pi accepts
  `minimal | low | medium | high | xhigh | max` and rejects anything else
  at spawn (fail-loud — pi CAN set the level). An adapter that CANNOT set
  thinking declares `thinkingLevelControl: false`; a non-default request
  against it degrades to **warn + proceed**.
- Resolution precedence (most specific wins; an explicit `"default"` at a
  narrower tier shadows wider tiers — you can un-set a global per runtime):
  1. spawn options (`model`, `thinkingLevel`)
  2. `[runtimes.<id>.roles]` per-runtime per-role entries
  3. `[models.roles]` / `[thinking.roles]`
  4. `[runtimes.<id>]` per-runtime `model` / `thinking_level`
  5. `[models] default` / `[thinking] default`

See [CONFIG.md](./CONFIG.md) for the exact schema and examples.

## Single-writer rule (SPEC ruling 1)

One prompt-owner per live turn:

- `prompt()` while ANY turn is live is queued (event `queued`,
  `reason: single-writer`) and delivered when the agent goes idle — turns
  never interleave, and the queued caller's promise resolves only after
  their turn completes.
- The live turn's owner keeps native mid-turn channels: `steer()` and
  `followUp()` pass straight through to the runtime.
- A non-owner's `steer()`/`followUp()` during a live turn queues like a
  prompt.

## Fallback semantics (interface layer)

Runtimes declaring `steer: "queued"` (cannot interrupt mid-turn) get
`withFallbacks()` wrapping (`src/runtime/fallbacks.ts`): `steer()` while
busy is held and delivered as a prompt at idle — the caller observes a
`queued` event with `reason: steer-unable`, and the call resolves after
delivery. The same contract a native-steer runtime offers, implemented
above the adapter.

## Session store (SPEC ruling 12)

Sessions persist as **append-only jsonl** under `<data_dir>/sessions/`,
in standard pi patterns: `sessions/<role>/--<dashed-cwd>--/<timestamp>_<uuid>.jsonl`.
The path is declared via `/health` (`session.path`).

- **Exclusive lock**: the active session file holds an inter-process
  exclusive lock (sidecar `<file>.lock`, pid + heartbeat). A second writer
  is rejected loudly, naming the holder. A stale lock (dead pid, heartbeat
  older than 60s) is stolen and logged. The lock is released on graceful
  shutdown and on handle dispose.
- **Hourly rolling backup**: tracked session files are copied hourly into
  `<data_dir>/sessions/backups/` with an ISO-hour suffix; per source file
  the newest 24 backups are retained (pruned oldest-first). A backup pass
  also runs at boot.
- **Growth detection on boot** (the emergency-console contract): the store
  snapshots session-file sizes at graceful shutdown and after each backup
  pass. On boot it re-scans; any file that grew (or appeared) while the
  service was down is reported via `/health`
  (`liveness.signals.session_growth`) and a `warn` log line naming the
  file and byte delta. Resuming re-reads the file, so the console's edits
  are picked up naturally.

### Emergency console (documented workflow)

Stop the service (this releases every session lock — single-writer
preserved by the stop), open the newest session jsonl under the path
`/health` declares with the pi CLI (or any editor), edit/inspect, restart
the service. The boot scan surfaces exactly what changed while you were
in there.

## /health liveness (SPEC rulings 5/12)

Since this epic the three liveness signals carry real values from the
runtime registry and session store (`stubbed: false`):

- `health_reachable` — this very response.
- `agent_session` — aggregate session state (`no-session` / `idle` /
  `streaming`) plus the most recent activity timestamp.
- `session_growth` — the boot report: `none`, or the list of files that
  grew while the service was down (file, byte delta).

## Testing

- The default suite runs fully offline: a stub model provider is
  registered into a real (offline) pi `ModelRuntime`, and ambient
  machine credentials are stripped for the test run
  (`test/helpers/env-setup.ts`).
- **Opt-in live smoke test** (requires a configured pi install):

  ```bash
  GRU_COMMAND_SMOKE=1 npx vitest run test/smoke-real-model.test.ts
  ```

  Uses the real agent dir and the runtime's default model; skipped (and
  exempt from nothing else) in normal runs.
