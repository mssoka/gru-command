# Runtime parity: pi and Claude Code

GRU command runs its minions on either runtime adapter, `pi` or `claude-code`,
and must work equally well on both (#374). Claude Code is the default for new
installs and generated configs. Existing `config.toml` files keep the runtime
they already name (owner ruling 2026-10-16, #374; see
[RUNTIMES.md](./RUNTIMES.md#default-runtime)).

This page is the parity matrix: every runtime-dependent contract, and the test
that proves it on each adapter.

## How parity is enforced

- Each contract's tests carry a tag at the end of their title.
  - `#contract:<id>:pi` marks a test against the pi adapter.
  - `#contract:<id>:claude-code` marks a test against the Claude Code adapter.
  - `#contract:<id>:neutral` marks a contract proven above the adapter layer,
    through the runtime-neutral `AgentHandle` interface.
- `test/runtime-parity.test.ts` reads the two tables below and every test
  title. Only a test registered with a plain `it(` on its own line, outside
  any block whose `describe` carries `skip`, `skipIf`, `runIf` or `todo`
  (chained modifiers included), counts as proof. The scan follows blocks by
  indentation. A test that skips itself from inside its own body, or a block
  formatted unusually, cannot be seen by the guard; review catches that. The
  guard fails when:
  - a contract lacks a test on either runtime (a neutral test covers both);
  - a tag is malformed or names a contract the matrix does not list;
  - a runtime's tag sits in the other runtime's adapter test file, or a
    `:neutral` tag sits in either adapter test file;
  - a matrix cell does not name the file of a test tagged for it, or names a
    file that does not exist or holds no tag for that contract on that
    cell's runtime;
  - a declared gap is not a matrix row marked as a gap, has no issue, or a
    row marked as a gap is not declared;
  - an adapter test file (`test/pi-adapter.test.ts`,
    `test/claude-adapter.test.ts`) grows a top-level `describe` block that the
    block map below does not place.
- **What the guard cannot do.** It holds every DECLARED contract on both
  runtimes, but it cannot detect a runtime-dependent behaviour nobody
  declared. A new test inside an `umbrella` block is not checked either. So
  a change that adds runtime-dependent behaviour adds its row here and tags a
  test on each runtime, or a `:neutral` test that drives it through
  `AgentHandle`. Review asks for that row; a pi test alone or a Claude test
  alone then fails the guard.
- **A gap is a row too.** A capability one runtime cannot provide is listed
  under [Declared gaps](#declared-gaps). Its row is "proven" on the gap side
  by a test that pins the named refusal, never by pretending the capability
  exists.

## Parity matrix

<!-- parity-matrix:start -->
| Contract | Behavior | pi | Claude Code |
|---|---|---|---|
| `session-roundtrip` | A prompt streams ordered deltas and turn lifecycle into a durable session file under the store, with the lock held | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `thinking-deltas` | Thinking deltas arrive before text when the model reasons | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `capabilities` | Each adapter declares its capabilities honestly in the matrix | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `images` | Image prompts reach the model in the runtime's own shape | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `steering` | Mid-turn input is delivered once. pi uses native follow-up; Claude queues steer and delivers it as a second process after idle | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `in-band-error` | An errored turn resolves with an error event and error state, and the next turn recovers | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `provider-failure-typed` | A provider failure carries typed status, code and identity, so the quota-wall stop, rate-limit retry and recovery sensor act on it | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `model-resolution` | `"default"` defers to the harness. An explicit reference is applied or fails loud, never silently replaced | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `registry-policy` | The registry resolves each role to its configured runtime and model/thinking policy | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `session-resume` | A previous session file resumes with its history intact after a process restart | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `resume-outside-store-refused` | A resume file outside the session store is refused | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `foreign-transcript-refused` | A transcript the other runtime wrote is refused by name, with no lock left behind and its bytes untouched. It is never resumed as a fresh session | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `isolated-review-no-resume` | An isolated review never resumes, so ambient history cannot cross the boundary | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `isolated-review-tools` | An isolated review gets exactly its review tools; ambient runtime resources are stripped | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `review-native-tools` | A lens session gets exactly its declared product-native tools: in-process for pi, a scoped MCP bridge for Claude | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `compaction` | Native compaction keeps the same session identity | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `dispose-releases-lock` | Dispose stops the turn and releases the session lock | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `cessation-proven` | Adapter-owned proof (pi: a confirmed idle; Claude: the original child's close) makes disposal `ceased` | `test/runtime-cessation-evidence.test.ts` | `test/runtime-claude-cessation-ownership.test.ts` |
| `cessation-unproven-holds-permit` | Without that proof, evidence stays `unknown` and the resident permit is held as debt | `test/runtime-positive-cessation-ownership.test.ts` | `test/runtime-claude-cessation-ownership.test.ts` |
| `scheduled-verification` | The #315 guard refuses a scheduled-verification producer before it runs | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `spawn-cwd` | A session is rooted at the explicit project cwd, never the workspace root | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts` |
| `blind-transcript-reader` | The blind-access reader pairs each read result with the file its call named, read from each runtime's real persisted record shape | `test/blind-review.test.ts` | `test/blind-review.test.ts` |
| `blind-read-invalidates` | Through the ledger, an absolute read inside the job's recorded lane invalidates blind coverage | `test/blind-review.test.ts` | `test/blind-review.test.ts` |
| `blind-resumed-turn-scan` | A prohibited read during a provider-recovery resumed turn invalidates blind coverage | `test/provider-recovery-resume.test.ts` | `test/provider-recovery-resume.test.ts` |
| `native-directive-admission` | A Silas directive's native admission and producer ownership are attested before any effect, and the directive settles with its delivery. pi: an accepted directive runs as its exact SDK producer. Claude Code (#424): the binding is durable before the CLI starts, admission is the CLI's own echo of the prompt (`--replay-user-messages`), every tool asks the host through the stdio permission prompt and is allowed only once its intent is durable and the directive's authority still holds, and completion is the turn's own result | `test/pi-adapter.test.ts` | `test/claude-adapter.test.ts`, `test/restart-recovery-progress.test.ts` |
| `rate-limit-retry` | An in-band 429 keeps the delivery pending until the supervisor's automatic retry recovers; driven through `AgentHandle` | `test/supervisor.test.ts` | `test/supervisor.test.ts` |
| `supervisor-restart-ladder` | A hung agent climbs the restart ladder and is restored by resume; driven through `AgentHandle` | `test/supervisor.test.ts` | `test/supervisor.test.ts` |
| `provider-recovery-continuation` | A provider-recovery claim resumes the interrupted session and re-delivers its continuation prompt; driven through `AgentHandle` | `test/provider-recovery-resume.test.ts` | `test/provider-recovery-resume.test.ts` |
| `stale-spawn-quarantine` | A quarantined handle (GH-280) loses lookup eligibility until disposal. This is proven in the registry, for any adapter | `test/runtime-resident-registry.test.ts` | `test/runtime-resident-registry.test.ts` |
<!-- parity-matrix:end -->

## Adapter test blocks

Every top-level block in the two adapter test files is placed here. A block maps
to the contract it proves (`umbrella` for the long round-trip block, which holds
tests for many contracts), or is `adapter-internal`: a pure parser or a pin with
no counterpart on the other runtime.

<!-- adapter-blocks:start -->
| File | Top-level block | Contract or kind |
|---|---|---|
| `test/pi-adapter.test.ts` | PiRuntime over the stub model (offline SDK round-trip) | umbrella |
| `test/pi-adapter.test.ts` | RuntimeRegistry | registry-policy |
| `test/pi-adapter.test.ts` | Perkins r1 regressions | umbrella |
| `test/pi-adapter.test.ts` | Perkins r1 boot-surface pins | adapter-internal |
| `test/pi-adapter.test.ts` | path normalization | adapter-internal |
| `test/pi-adapter.test.ts` | Perkins r2: concurrent double-resume race (B4-race) | session-resume |
| `test/pi-adapter.test.ts` | Perkins r3: gated-twin scenario (winner-ensures-lock leg) | session-resume |
| `test/pi-adapter.test.ts` | spawn cwd (SPEC ruling 17 — dispatch roots in the project) | spawn-cwd |
| `test/pi-adapter.test.ts` | typed provider-response provenance (r1 #13) — pure parsers | provider-failure-typed |
| `test/pi-adapter.test.ts` | scheduled verification ordinary Pi Bash | scheduled-verification |
| `test/claude-adapter.test.ts` | ClaudeCodeRuntime over the stubbed CLI double | umbrella |
| `test/claude-adapter.test.ts` | RuntimeRegistry + claude-code (fallback-wrapped) | registry-policy |
| `test/claude-adapter.test.ts` | NdjsonParser (pure) | adapter-internal |
| `test/claude-adapter.test.ts` | ClaudeControlTranslator (pure) | adapter-internal |
| `test/claude-adapter.test.ts` | ClaudeTurnTranslator (pure) | adapter-internal |
| `test/claude-adapter.test.ts` | ReviewMcpBridge bounded protocol failures | review-native-tools |
| `test/claude-adapter.test.ts` | spawn cwd (SPEC ruling 17 — dispatch roots in the project) | spawn-cwd |
| `test/claude-adapter.test.ts` | isolated-review confinement guards | isolated-review-tools |
| `test/claude-adapter.test.ts` | ReviewMcpBridge fail-closed guards | review-native-tools |
| `test/claude-adapter.test.ts` | scheduled verification ordinary Claude Bash | scheduled-verification |
<!-- adapter-blocks:end -->

## Above the adapter layer

These paths see a runtime only through the `AgentHandle` interface and its
events. Their suites drive them with fake handles, so one test covers both
runtimes. Each has a `:neutral` row in the matrix:

- the supervisor restart ladder (`supervisor-restart-ladder`) and its
  rate-limit retry (`rate-limit-retry`);
- provider-recovery continuation (`provider-recovery-continuation`);
- resident registry custody (`stale-spawn-quarantine`).

Directive restart recovery (#286) is NOT runtime-neutral. pi continues an
interrupted directive from its own native checkpoint; Claude Code never
continues one (see Differences by design).

## Declared gaps

<!-- declared-gaps:start -->
| Contract | Gap | Issue |
|---|---|---|
<!-- declared-gaps:end -->

None today. #424 closed the last one: Claude Code minions take Silas
directives and re-briefs with exact admission proof, as pi does. The
intentional differences (an interrupted directive is never resumed, a
directive is text only, and a session that cannot attest admission refuses)
are listed under Differences by design.

Blind-review observation reads each runtime's own transcript format. The
`blind-transcript-reader` and `blind-read-invalidates` rows run on fixtures
copied from real Claude Code and pi sessions (#360). `blind-resumed-turn-scan`
writes each runtime's own record shape during a resumed turn.

## Differences by design

- **Follow-up.** pi delivers native follow-up messages. Claude Code declares
  `followUp: false`, and the registry queues steer as a single writer. The
  `steering` row proves each runtime's path.
- **Models.** pi resolves `provider/model` against its catalog, with one bounded
  refresh. Claude Code is always Anthropic and passes the model to the CLI;
  every Claude model accepts images.
- **Thinking levels.** pi accepts `minimal`, and Claude accepts `ultracode`.
  Neither falls back silently. See
  [RUNTIMES.md](./RUNTIMES.md#model--thinking-level-policy-spec-ruling-16).
- **MCP servers.** Claude Code loads none by default (`[runtimes.claude-code]
  mcp`). pi sessions get their product-native tools in-process, with no MCP
  bridge (see the `review-native-tools` row).
- **An interrupted directive.** pi continues it from its native checkpoint
  when that checkpoint is safely resumable. Claude Code never continues or
  replays one (owner ruling 2026-10-16): the CLI cannot continue a turn
  without a new prompt, so an interrupted Claude directive is Gru's recovery
  decision (`test/restart-recovery-progress.test.ts`, "an interrupted Claude
  directive is never resumed or replayed …" and "a service that died
  mid-directive …").
- **Directive sessions.** A Claude Code transcript starts with a GC session
  header (session id and cwd), which directive admission binds. A directive
  and a re-brief both run in the minion's recorded session, so two kinds of
  Claude session refuse them by name before anything is bound:
  - one started before the header existed (every session GC starts from now
    on has it);
  - one that loads ambient MCP tools (`[runtimes.claude-code] mcp`). This is
    intentional: the host fences every tool it lists, and it cannot list tools
    it does not know.
- **Directive content.** A Claude directive is text only (an image is refused
  by name): the CLI may transform an image, which would break the byte-exact
  echo admission binds.

## Rollout of the default change

- **New installs.** The setup wizard and `config-generate` write
  `[runtimes] default = "claude-code"`. Setup fails loud when the `claude` CLI
  is missing, naming how to choose `pi` instead (`test/config-generate.test.ts`,
  "missing claude CLI fails loud …").
- **Existing installs.** Nothing changes. A `config.toml` keeps the runtime it
  names, and one with no `[runtimes]` table still resolves to `pi`.
  Regenerating with `--force` keeps the existing runtime unless another is
  chosen explicitly (`test/config-generate.test.ts`, "an existing pi config …
  is untouched by --force regeneration").
- **Before switching an install to Claude Code**, note that an interrupted
  directive is never resumed on Claude Code; Gru decides its recovery (see
  Differences by design).
- **Live sessions when an install switches by hand.** A transcript belongs to
  the runtime that wrote it. The other adapter refuses to resume it by name and
  releases its lock (`foreign-transcript-refused`), so a switched install never
  silently restarts a lane from an empty session. Let live lanes finish, or
  dispose them, before editing `[runtimes] default`.
- **Recorded runtime ids.** A review-owner marker records the runtime that
  wrote it and is judged by that runtime's rules, never by the current default.
  A Claude marker is never released by PID death alone
  (`test/perkins-builtin-wave.test.ts`, `reviewOwnerCeased` for `claude-code`).
