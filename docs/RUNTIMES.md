# Runtime adapters

Gru Command hosts every agent session behind the `AgentRuntime` interface
(`src/runtime/types.ts`). Nothing above the adapter layer may import a
concrete adapter — the interface is the contract (SPEC ruling 4).

## Capability matrix

| Capability | `pi` | `claude-code` | Meaning |
|---|---|---|---|
| `streaming` | ✅ | ✅ | text/thinking deltas emitted live (claude: `--include-partial-messages`, with a complete-frame fallback) |
| `steer` | `native` | `queued` | mid-turn steering; claude's `-p` surface has no mid-turn channel → the interface layer queues-until-idle |
| `resume` | `file` | `file` | sessions resume from durable state (claude: `--session-id`/`--resume` chaining) |
| `images` | ✅ | ✅ | image content accepted in prompts (claude: base64 blocks in the stdin user frame) |
| `thinking` | ✅ | ✅ | thinking output surfaced as events |
| `thinkingLevelControl` | ✅ | ✅ | thinking level settable per spawn (claude: `--effort`) |
| `followUp` | ✅ | ❌ | claude has no native followUp channel — queued messages deliver as fresh prompt turns |

## Context controls

`AgentHandle` also has optional provider-owned controls:
`getContextUsage()` (fresh whole-context tokens/window/percent or `null`),
`compact()` (native in-place compaction), `canCompact()` (live idle/capability
check), and `isCompacting()`. `canCompact()` may be false even when the method
exists, while a turn, queue, or native reconciliation is active. These are not
inferred capability booleans: presence plus live state determines the chat
snapshot. Fallback wrappers forward them while preserving their
single-operation queue.

- **Pi:** usage comes directly from `AgentSession.getContextUsage()` and
  compaction from `AgentSession.compact()`. Native compaction lifecycle
  events map to runtime `compaction_start/end`; the adapter owns one lifecycle
  through post-terminal identity reconciliation, ignores provider duplicates,
  and emits exactly one failed terminal if disposal wins. The terminal event is
  the result authority (missing/failed terminals reject), and the adapter
  verifies the session id/file did not change.
- **Claude Code:** print mode does not expose trustworthy whole-context
  usage, so usage is deliberately unavailable. Compaction runs native
  `/compact` through a dedicated `--resume <same uuid>` machine-output
  process. Its frames append to the same product transcript for forensics,
  but a control-only translator suppresses all command output from chat.
  Init/session/result frames and the native compact status/boundary are
  validated; a successful slash-command result alone is not success, and
  failure leaves the session usable.

Both adapters reject controls while a turn/control is active. Claude disposal
is shared by concurrent callers and bounded through TERM/KILL plus transcript
settlement before releasing the session lock. New chat is not an adapter
`reset`: orchestration mints a wholly fresh unresumed handle and atomically
swaps it at the durable chat boundary.

## Claude Code adapter (`claude-code`)

Hosts sessions on the Claude Code **headless CLI** — `claude -p` with
stream-json I/O and session-resume flags (SPEC ruling 4: the CLI surface,
NOT the SDK/control protocol).

**Process-per-turn.** Every delivered prompt spawns one process:

```
claude -p --output-format stream-json --input-format stream-json \
  --verbose --include-partial-messages \
  (--session-id <uuid> | --resume <uuid>) [--model M] [--effort E] \
  --permission-mode bypassPermissions --tools <role tools> \
  --append-system-prompt <role prompt>
```

fed with ONE stdin user frame (text, or image blocks + text) followed by
EOF; the turn ends with the `result` frame and the process exits (exit 0).
There is no long-lived process and no mid-turn channel: `steer` is a
declared gap (`queued`), served by the interface fallback — a mid-turn
steer is held and delivered as a fresh prompt turn once the agent is
idle, never interleaved.

**Session continuity.** The adapter mints the session UUID at spawn
(`--session-id` on the first turn) and chains later turns with `--resume`
on the same UUID. Continuity rides claude's own transcript store under
`~/.claude/` — that is the harness's private resume substrate; the product
never reads it. The PRODUCT transcript is the raw NDJSON frame stream
appended verbatim to the session-store file
(`sessions/<role>/--<dashed-cwd>--<hash8>/<ISO-ts>_<session-uuid>.jsonl`),
so the lock / hourly backup / boot growth-detection machinery applies
unchanged (SPEC ruling 12). Resume by `resumeFile` reads the session id
back out of the transcript's frames, is confined to the store, locks
before reading, and rejects a file already hosted by this process.

**Emergency console** for a claude-hosted session: stop the service, then
`claude --resume <session-uuid>` in the workspace (pre-v2.1.223 CLIs only
search the current project directory for a session id — the adapter always
spawns with cwd = the configured workspace root, which keeps this working;
newer CLIs find it from anywhere). The product transcript is not claude's
format — it is the forensic record, not the console's input.

**Events.** `system/init` starts the turn (state `streaming`, `turn_start`;
a session-id mismatch kills the process and rejects — never continue a
foreign session). `stream_event` partials become text/thinking deltas and
tool input updates; complete `assistant` frames are the no-partials
fallback (per-kind dedupe: never emitted twice); `tool_use`/`tool_result`
blocks become `tool_start`/`tool_end` (`is_error` → `isError`);
`tool_progress` heartbeats become `tool_update`. A `result` frame ends the
turn: `is_error: true` is an IN-BAND error (error event, sticky `error`
state, the prompt RESOLVES, the next turn recovers — pi parity); a process
that exits without any result frame is a transport failure (the prompt
REJECTS with the stderr tail). Informational frames
(`rate_limit_event`, hook events, `api_retry`, unknown future types) are
skipped by design. Dispose SIGTERMs (the CLI aborts and exits 143),
escalating to SIGKILL after a grace window.

**Permissions and roles.** Headless has no interactive approval channel,
so sessions run `--permission-mode bypassPermissions` with `--tools`
restricted to the role's mapped built-ins (read→Read, bash→Bash,
edit→Edit, write→Write, grep→Grep, find→Glob, ls→LS); the role system
prompt rides `--append-system-prompt`. MCP tools follow the user's own
claude configuration (`--tools` restricts built-ins only). The richer
per-role permission model is E8 territory; LAN bind + pairing token
(ruling 9) is the v1 security perimeter.

**Model & thinking.** `"default"` omits both flags (claude's own
configuration decides). An explicit `"provider/model"` reference strips
the provider segment for `--model` (`anthropic/claude-x` → `claude-x`;
Bedrock-style dotted ids survive: `bedrock/us.anthropic.claude-x` →
`us.anthropic.claude-x`). Thinking maps to `--effort`; claude accepts
`low | medium | high | xhigh | max | ultracode` — anything else (e.g. pi's
`minimal`) fails loud at spawn naming the valid set. `--effort` is a
recent CLI flag: a too-old binary fails at startup with a stderr naming
the flag, which surfaces as a loud transport failure at the first prompt.

**Failure health.** A `claude` binary that is missing/unrunnable at spawn
(probed once, cached, re-probed after failure) marks the adapter `down`
and the error names the binary; a mid-life ENOENT does the same. A turn
that crashes does NOT mark the adapter down — the binary demonstrably
worked. Caller-facing spawn failures (a stale/foreign/corrupt
`resumeFile`, a lock conflict, a double-resume) never touch adapter
health either. A spawned-but-never-prompted transcript (empty file —
service restart between spawn and first prompt) resumes by adopting the
session uuid from its FILENAME and re-minting it on the first turn —
the session never registered CLI-side, so there is nothing to `--resume`.

**Turn liveness** is NOT the adapter's job: there is deliberately no
turn-duration or frame-silence timeout here (a wedged `claude` process
pends its prompt until disposed). The supervision epic (E7) owns restart
ladders and crash-loop breakers; the operator escape is `dispose()`.

Note: piped stdin is capped at 10MB by the CLI — prompts with large image
sets must stay under it (fine for chat-scale attachments). The transcript
append stream ignores backpressure per frame — frame sizes are bounded by
the CLI's own tool-output truncation, so the buffer stays small in
practice.

## Runtime probe (E9 wizard feed)

`src/runtime/probe.ts` — `probeRuntimes()` detects the installed runtime
CLIs (`pi`, `claude`): resolves the binary on PATH, runs `--version` with
a timeout, parses the first semver token (raw line kept), and attaches the
adapter's declared capability set. Absence/failure/timeout report
`installed: false` — the probe never throws. Synchronous by design: it
runs at wizard/boot time, never on a hot path.

## Model & thinking level policy (SPEC ruling 16)

- **Default = the runtime harness's own configuration.** The sentinel
  `model = "default"` means "whatever pi / Claude Code is themselves
  configured to use" — the product never hardcodes a model. (An empty
  value means the same at the `[models].default` / `[thinking].default`
  tiers only — kept for configs written before the runtime layer shipped;
  every other tier rejects empty overrides.)
- Explicit overrides are `"provider/model"` strings (pi) validated
  **fail-loud** at spawn: an unresolvable reference is an error naming the
  reference, never a silent fallback.
- Thinking levels: `"default"` passes through; pi accepts
  `minimal | low | medium | high | xhigh | max` and rejects anything else
  at spawn (fail-loud — pi CAN set the level). claude-code accepts
  `low | medium | high | xhigh | max | ultracode` (mapped to `--effort`)
  and likewise rejects the rest. An adapter that CANNOT set
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
  prompt. Unnamed callers are attributed to the HANDLE's own principal
  (one chat brain per session); two distinct sessions always attribute
  differently, so a stranger can never steer natively. Attribution is
  identity-by-name, not authentication: a caller who knowingly claims the
  owner's name passes through. (Real auth arrives with pairing, E4/E9.)

## Fallback semantics (interface layer)

Runtimes declaring `steer: "queued"` (cannot interrupt mid-turn) get
`withFallbacks()` wrapping (`src/runtime/fallbacks.ts`): the uniform
never-interleave contract — while a turn is live, prompt() AND steer()
are held and delivered in arrival order once the agent reports a
non-busy state (idle OR error — an error-ended turn never strands the
queue). Held steer calls carry reason `steer-unable`; held prompt/
followUp calls carry reason `single-writer`. Callers observe the queue
event and their call resolves after their delivered turn completes —
the same guarantee a native-steer runtime offers, implemented above the
adapter.

No session spawns in production until the chat epic (E4) — the registry
exists, boots, and is health-observable; `agent_session` honestly reads
`no-session` until then.

## Session store (SPEC ruling 12)

Sessions persist as **append-only jsonl** under `<data_dir>/sessions/`,
in standard pi patterns: `sessions/<role>/--<dashed-cwd>--<hash8>/<timestamp>_<uuid>.jsonl`
where `<hash8>` is an 8-hex sha256 prefix of the resolved cwd (pi's own
dashed transform collides for `/a-b/c` vs `/a/b-c` — the suffix keeps
them distinct). The path is declared via `/health` (`session.path`).
The sessions dir is created owner-only (0700): transcripts carry full
prompt/tool content, so nothing but the owner should traverse it.

- **Exclusive lock**: the active session file holds an inter-process
  exclusive lock (sidecar `<file>.lock`, pid + heartbeat). A second writer
  is rejected loudly, naming the holder. A stale lock (dead pid, heartbeat
  older than 60s) is stolen and logged. The lock is released on graceful
  shutdown and on handle dispose.
- **Hourly rolling backup**: tracked session files are copied hourly into
  `<data_dir>/sessions/backups/` with an ISO-hour suffix; per source file
  the newest 24 backups are retained (pruned oldest-first). A backup pass
  also runs at boot. The slot IS the ISO hour: a second pass in the same
  hour refreshes that slot (freshest in-slot state wins). Backups copy
  live files, so a trailing line may be partial — recovery tooling must
  tolerate a torn tail.
- **Change detection on boot** (the emergency-console contract): the store
  snapshots session-file sizes at graceful shutdown and after each backup
  pass. On boot it re-scans; any file that grew OR shrank while the
  service was down is reported via `/health`, and a file that VANISHED is
  reported with kind `deleted` (a console delete must never pass
  silently).
  (`liveness.signals.session_growth`) and a `warn` log line naming the
  file, the kind of change, and the byte delta. A missing snapshot means
  a first-ever boot; a corrupt snapshot is reported as `corrupt`
  (degraded — findings run against an empty baseline). Resuming re-reads
  the file, so the console's edits are picked up naturally.

### Emergency console (documented workflow)

Stop the service (this releases every session lock — single-writer
preserved by the stop), open the newest session jsonl under the path
`/health` declares with the pi CLI (or any editor), edit/inspect, restart
the service. The boot scan surfaces files that grew, shrank, or vanished
while you were in there.

## /health liveness (SPEC rulings 5/12)

Since this epic the three liveness signals carry real values from the
runtime registry and session store (`stubbed: false`):

- `health_reachable` — this very response.
- `agent_session` — aggregate session state (`no-session` / `idle` /
  `streaming`) plus the most recent activity timestamp.
- `session_growth` — the boot report: `none`, or the list of files that
  grew, shrank, or were deleted while the service was down (file, kind,
  byte delta).

Note: `/health` discloses absolute paths (workspace, data dir, session
files) — stage-consistent with the loopback-only bind of the pre-UI
epics; the pairing token (and the LAN bind) arrive with the UI epic.

## Testing

- The default suite runs fully offline: a stub model provider is
  registered into a real (offline) pi `ModelRuntime`, the claude-code
  adapter is exercised against a stubbed CLI double (a real child process
  speaking stream-json, driven by prompt sentinels), the runtime probe
  runs on fixture PATHs, and ambient machine credentials are stripped for
  the test run (`test/helpers/env-setup.ts`). The default suite never
  spawns a real `pi` or `claude`.
- **Opt-in live smoke tests** (require configured local installs):

  ```bash
  GRU_COMMAND_SMOKE=1 npx vitest run test/smoke-real-model.test.ts   # live pi
  GRU_COMMAND_SMOKE_CLAUDE=1 npx vitest run test/smoke-claude.test.ts # live claude
  ```

  Skipped in normal runs (the default suite never touches the network).
  The claude smoke exercises one live round-trip plus one resume turn.
