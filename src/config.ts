import { lstatSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse, type TomlPrimitive } from 'smol-toml';
import { parseQuietHours } from './chat/wake-policy.js';
import { DEFAULT_INPUT_PRICE_PER_MTOK, validateProviderProfile } from './decisions/profile.js';
import { displayManagedRepoName, managedRepoNameError } from './repos/managed-names.js';
import type { SurfaceMode } from './decisions/types.js';
import { SILAS_AUTOPILOT_RULE_IDS } from './dispatch/silas-rules.js';

/** Roles are product-native and runtime-agnostic (SPEC ruling 15). */
export const ROLES = ['gru', 'silas', 'minion', 'perkins', 'bob'] as const;
export type Role = (typeof ROLES)[number];

/** Runtime adapters known to the config schema. Implementations land in E2/E3. */
export const RUNTIME_IDS = ['pi', 'claude-code'] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
}

/** The documented default instance port (wizard default / config reference). */
export const DEFAULT_INSTANCE_PORT = 7665;

/**
 * Explicit service-port override for SPAWNED instances (owner incident
 * 2026-09-23, port-squat prevention): `GRU_SERVICE_PORT` beats the config
 * file's `[server] port`. The test/e2e harness hands every spawned service
 * its port through this env var so a worktree-spawned service can never
 * inherit the real instance port; `src/service-port-guard.ts` refuses a
 * fixed port without it from a git worktree.
 */
export const SERVICE_PORT_ENV = 'GRU_SERVICE_PORT';

export interface AuthConfig {
  readonly token: string;
}

export interface RuntimesConfig {
  readonly default: RuntimeId;
  readonly roles: Readonly<Partial<Record<Role, RuntimeId>>>;
  /** Per-runtime model & thinking policy (SPEC ruling 16). */
  readonly policies: Readonly<Partial<Record<RuntimeId, RuntimeModelPolicy>>>;
}

/** Model + thinking overrides scoped to one runtime adapter (SPEC ruling 16). */
export interface RuntimeModelPolicy {
  readonly model?: string;
  readonly thinkingLevel?: string;
  /** pi only: when a model reference misses the offline catalog, allow ONE
   * bounded network catalog refresh before failing (default true). Set false
   * for a strictly offline catalog. */
  readonly modelRefresh?: boolean;
  /** pi only: deadline for that refresh, in milliseconds (default 10 000). */
  readonly modelRefreshTimeoutMs?: number;
  /** claude-code only: which MCP servers non-review sessions may load
   * (default "none" — exactly the role's mapped tools, like pi). */
  readonly mcp?: ClaudeMcpMode;
  readonly roles: Readonly<Partial<Record<Role, RuntimeRolePolicyEntry>>>;
}

/**
 * [runtimes.claude-code] mcp — the MCP servers a non-review claude-code
 * session loads (owner decision 2026-10-15: off by default, opt-in):
 *   none    — no MCP servers; the session gets only its role's tools
 *   project — only the servers in the session cwd's .mcp.json as committed
 *             at HEAD (byte-identical working file), for roles with a shell
 *   user    — everything the operator's own Claude configuration loads
 * Isolated review sessions and narrowed role-tool sets never load ambient
 * MCP regardless.
 */
export const CLAUDE_MCP_MODES = ['none', 'project', 'user'] as const;
export type ClaudeMcpMode = (typeof CLAUDE_MCP_MODES)[number];
/** Default for [runtimes.claude-code] mcp. */
export const DEFAULT_CLAUDE_MCP_MODE: ClaudeMcpMode = 'none';

/** Default for [runtimes.pi] model_refresh (network catalog refresh ON). */
export const DEFAULT_MODEL_REFRESH = true;
/** Default for [runtimes.pi] model_refresh_timeout_ms. */
export const DEFAULT_MODEL_REFRESH_TIMEOUT_MS = 10_000;

/** Fully-resolved pi model-catalog refresh policy for one spawn process. */
export interface ModelRefreshPolicy {
  readonly enabled: boolean;
  readonly timeoutMs: number;
}

/**
 * Resolve the pi model-catalog refresh policy from [runtimes.pi]. The
 * product lives on a networked machine, so an unknown model triggers one
 * bounded refresh by default; `model_refresh = false` keeps the catalog
 * strictly offline. The timeout bounds the refresh either way.
 */
export function resolveModelRefreshPolicy(
  config: GruCommandConfig,
  runtimeId: RuntimeId = 'pi',
): ModelRefreshPolicy {
  const policy = config.runtimes.policies[runtimeId];
  return {
    enabled: policy?.modelRefresh ?? DEFAULT_MODEL_REFRESH,
    timeoutMs: policy?.modelRefreshTimeoutMs ?? DEFAULT_MODEL_REFRESH_TIMEOUT_MS,
  };
}

/** Per-role overrides inside a runtime policy; at least one field set. */
export interface RuntimeRolePolicyEntry {
  readonly model?: string;
  readonly thinkingLevel?: string;
}

export interface ModelsConfig {
  readonly default: string;
  readonly roles: Readonly<Partial<Record<Role, string>>>;
}

export interface ThinkingConfig {
  readonly default: string;
  readonly roles: Readonly<Partial<Record<Role, string>>>;
}

/** In-process supervision policy (EPICS E7; SPEC ruling 5 — the OS
 * service manager is the out-of-band watcher, this is the agent layer). */
export interface SupervisionConfig {
  readonly enabled: boolean;
  /** A streaming/spawning turn with no runtime event AND no session-file
   * growth AND no live tool process for this long is hung (E3's
   * turn-liveness deferral, E7 home). */
  readonly turnSilenceMs: number;
  /** Rolling crash-loop window; ≥ max_restarts inside it trips the breaker. */
  readonly restartWindowMs: number;
  readonly maxRestarts: number;
  /** Backoff base between restart rungs; doubles per consecutive failure,
   * capped at 60 s. */
  readonly restartBackoffMs: number;
}

/** Size-based log rotation (E1 deferral, E7 home). */
export interface LoggingConfig {
  /** Rotate service.log when it exceeds this many bytes. */
  readonly maxBytes: number;
  /** Rotated files retained (oldest pruned first). */
  readonly keep: number;
}

/** Gru awareness wake policy (dispatch briefing 2026-09-22; owner ruling
 * 2026-09-23): whether the service may start a Gru turn by itself when
 * notifications land. */
export const NOTIFY_WAKE_MODES = ['never', 'action-required', 'all'] as const;
export type NotifyWakeMode = (typeof NOTIFY_WAKE_MODES)[number];

export function isNotifyWakeMode(value: string): value is NotifyWakeMode {
  return (NOTIFY_WAKE_MODES as readonly string[]).includes(value);
}

/** Severity floor for a wake turn ('info' = every routed notification may
 * wake; 'error' = only error-severity rows burn a turn). */
export const WAKE_MIN_SEVERITIES = ['info', 'error'] as const;
export type WakeMinSeverity = (typeof WAKE_MIN_SEVERITIES)[number];

export function isWakeMinSeverity(value: string): value is WakeMinSeverity {
  return (WAKE_MIN_SEVERITIES as readonly string[]).includes(value);
}

/** Local-time quiet window for autonomous wakes (minutes since midnight;
 * start > end wraps midnight). `null` = quiet hours off. */
export interface QuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
}

/** Chat frame-log rotation (E4 replay-cost deferral — same ruling) and the
 * Gru awareness wake policy. */
export interface ChatConfig {
  /** Rotate gru.frames.jsonl when it exceeds this many bytes. */
  readonly frameLogMaxBytes: number;
  /** Rotated shards retained; replay spans shards oldest→newest. */
  readonly frameLogKeep: number;
  /** When the service may start a Gru turn on its own for awareness:
   * 'never' injects escalations + a ledger digest passively before the
   * next turn at no turn cost by itself; 'action-required' (default,
   * owner ruling 2026-09-23) wakes a turn for machine-attention rows so
   * a critical alert is acted on without the user pinging; 'all' wakes
   * for every notification. Each wake is a full model turn — see
   * CONFIG.md. */
  readonly notifyWake: NotifyWakeMode;
  /** Minimum interval between autonomous wake turns (ms); candidates
   * inside the window coalesce into ONE trailing wake. 0 disables the
   * rate limit. */
  readonly wakeMinIntervalMs: number;
  /** Severity floor for a wake ('info' wakes for every routed row;
   * 'error' only for error-severity rows). */
  readonly wakeMinSeverity: WakeMinSeverity;
  /** Local-time quiet window (empty/off by default). Inside it, wakes
   * defer to the window's end. */
  readonly wakeQuietHours: QuietHours | null;
  /** Issue #219 kill switch: when true (default), an incident covered by
   * an active, basis-matched decision (issue #218) DEFERS its wake to the
   * decision's recheck instead of opening a turn; hard floors (breakers,
   * provider walls, needs-owner) always wake regardless. false restores
   * pre-#219 behavior. */
  readonly wakeDeferCovered: boolean;
  /** Code-only durable mailbox recovery cadence; no browser required. */
  readonly mailboxReconcileIntervalMs: number;
  /** Morning digest gap (ms): the first delivered block after this much
   * quiet time carries a "while you were away" digest (fires, actions,
   * merges, staged PRs) so the chief catches up without the owner
   * relaying. 0 disables the digest. */
  readonly morningDigestGapMs: number;
}

/** How GC frees disk space over `[worktrees] disk_budget_gb` or under
 * `min_free_disk_gb` (#427 PR 3): `automatic` frees it losslessly on its
 * own; `proposed` posts one FOR YOU card listing what it would free. */
export const RECLAIM_MODES = ['automatic', 'proposed'] as const;
export type ReclaimMode = (typeof RECLAIM_MODES)[number];

/** Worktree manager policy (E8; SPEC ruling 18). */
export interface WorktreesConfig {
  /** Root under which job/review worktrees are created. */
  readonly root: string;
  /** Where preserved untracked deliverables land on sweep. */
  readonly preserveRoot: string;
  /** Budget per one-time bootstrap setup command (ms). */
  readonly setupTimeoutMs: number;
  /** GC's disk budget in GB of 2^30 bytes (#427 PR 3): over it, GC frees
   * space losslessly; it never stops a heist. 0 disables it. */
  readonly diskBudgetGb: number;
  /** The disk's free-space floor in GB (#427 PR 3): below it, new job and
   * writer-child lanes wait while GC frees space. 0 disables it. */
  readonly minFreeDiskGb: number;
  readonly reclaimMode: ReclaimMode;
}

export const DEFAULT_DISK_BUDGET_GB = 30;
export const DEFAULT_MIN_FREE_DISK_GB = 10;

/** Dispatch flow policy (E8). */
export interface DispatchConfig {
  /** Bob's periodic consolidation interval; 0 disables the trigger. Ships
   * 0 (issue #221): the due-based dream pass is the learning loop that
   * feeds the crew, and the hourly knock mostly found nothing — its
   * memory files feed no code path. Re-enable deliberately. */
  readonly bobIntervalMs: number;
}

/** Book of Lessons policy (owner design 2026-09-23): journal capture →
 * dream distillation → bible references. */
export interface LessonsConfig {
  /** Master switch for the dream cadence and briefing injection. The
   * journal API stays available either way (capture is deliberate, and a
   * disabled dream must never lose entries). */
  readonly enabled: boolean;
  /** Dream cadence in ms: on boot plus every interval; 0 disables the
   * periodic trigger (the on-boot pass still runs). Default 12 h. */
  readonly dreamIntervalMs: number;
  /** Run one dream pass at service boot when new journal entries exist. */
  readonly dreamOnBoot: boolean;
  /** Hard cap per chapter file; the dream trims to fit. */
  readonly chapterCapBytes: number;
  /** Hard cap for INDEX.md (the only part ever embedded in briefings). */
  readonly indexCapBytes: number;
  /** Maximum pointer lines injected into one briefing/directive. */
  readonly maxReferences: number;
}

export const DEFAULT_LESSONS_CONFIG: LessonsConfig = {
  enabled: true,
  dreamIntervalMs: 43_200_000,
  dreamOnBoot: true,
  chapterCapBytes: 4_096,
  indexCapBytes: 1_024,
  maxReferences: 3,
};

/** How a Vector raid decision is made (#351): `proposed` waits for the
 * owner's Accept in FOR YOU; `autonomous` lets Gru act without asking. */
export const VECTOR_MODES = ['proposed', 'autonomous'] as const;
export type VectorMode = (typeof VECTOR_MODES)[number];

/** Vector's raids (#351): Gru-directed adversarial property campaigns off
 * the heist path. Raids spend quota, so every user opts in (`enabled`
 * defaults to false). Budgets never rise after failures or empty raids. */
export interface VectorConfig {
  /** true lets Gru plan raids; false = no candidate list, no Gru turn, no
   * Vector session, and a chat raid request is refused with the reason. */
  readonly enabled: boolean;
  /** Starting a raid Gru picked: wait for the owner, or launch. */
  readonly raidMode: VectorMode;
  /** Turning a break-in into a fix heist: wait for the owner, or dispatch. */
  readonly fixMode: VectorMode;
  /** How often code rebuilds the candidate list and, when it changed, gives
   * Gru one turn to pick; 0 = raids only on request. */
  readonly planIntervalMs: number;
  /** Attacks (Vector proposals) per raid. */
  readonly maxRounds: number;
  /** Sandboxed executions per raid (qualification controls, the attack,
   * the baseline and the replay each count). At least
   * VECTOR_MAX_RUNS_PER_ATTACK, or no attack could ever start. */
  readonly maxRuns: number;
  /** Wall-clock cap per raid. */
  readonly maxRaidMs: number;
  /** Token cap per raid where the runtime reports usage. */
  readonly maxRaidTokens: number;
  /** Raids per repository in any rolling 24 hours: started, waiting to run, or ended before starting. */
  readonly maxRaidsPerDay: number;
}

/** The most one raid attack can cost: both controls, the attack, then the baseline and the replay when it fails. */
export const VECTOR_MAX_RUNS_PER_ATTACK = 5;

export const DEFAULT_VECTOR_CONFIG: VectorConfig = {
  enabled: false,
  raidMode: 'proposed',
  fixMode: 'proposed',
  planIntervalMs: 86_400_000,
  maxRounds: 4,
  maxRuns: 16,
  maxRaidMs: 1_800_000,
  maxRaidTokens: 400_000,
  maxRaidsPerDay: 2,
};

/** What GC does about a managed repository whose origin default branch has
 * no `.gru-command/worktree.toml` (#427, docs/ONBOARDING.md): `proposed`
 * posts one FOR YOU card per repository; `autonomous` dispatches the
 * onboarding heist and posts an FYI row; `off` does nothing and ignores the
 * installer's consent. */
export const ONBOARDING_MODES = ['proposed', 'autonomous', 'off'] as const;
export type OnboardingMode = (typeof ONBOARDING_MODES)[number];

export interface OnboardingConfig {
  readonly mode: OnboardingMode;
}

export const DEFAULT_ONBOARDING_CONFIG: OnboardingConfig = { mode: 'proposed' };

/** Graceful self-roll policy (issue #34 graduation heist). */
export interface RollConfig {
  /** Bounded drain wait before a swap (ms); 0 snapshots and swaps now. */
  readonly drainTimeoutMs: number;
}

export const DEFAULT_ROLL_CONFIG: RollConfig = { drainTimeoutMs: 900_000 };

/** Silas ops-hosting policy (E8 follow-through; owner ruling 2026-09-21).
 * Silas closes the delivered→PR→review loop himself and breaks recurring
 * blocker loops; this section tunes his watchtower, never his authority. */
export interface SilasConfig {
  /** Master switch: false declares no silas slot and fires no wakes. */
  readonly enabled: boolean;
  /** Periodic sweep interval; 0 disables the sweep (event wakes still fire). */
  readonly sweepIntervalMs: number;
  /** GitHub signal poll interval (owner ruling 2026-09-23, POLL-ONLY):
   * tracked branches are observed through authenticated `gh api` for PR
   * merged state, mergeable_state (conflicts), and check-run conclusions.
   * 0 disables the poll (the sweep and event wakes stay live). */
  readonly pollIntervalMs: number;
  /** A working job whose minion shows no activity for this long is stalled. */
  readonly stallThresholdMs: number;
  /** Sweep wake gate (issue #217): a sweep whose digest fingerprint is
   * unchanged does not re-wake Silas until this much time has passed
   * since the last delivered wake (a bounded safety re-look). 0 = never
   * re-wake on an unchanged digest; a changed digest, an event whose
   * digest is non-empty, or a passed decision recheck always wakes (an
   * empty digest never wakes on its own — a due decision recheck still
   * does, issue #243). */
  readonly unchangedRewakeMs: number;
  /** Consecutive same-blocker rounds before a fix directive is advised. */
  readonly directiveAt: number;
  /** Consecutive same-blocker rounds before a fresh-minion re-brief. */
  readonly rebriefAt: number;
  /** Consecutive same-blocker rounds before escalation to the chief. */
  readonly escalateAt: number;
  /** Silas autopilot (issue #243): the unambiguous rule families executed
   * in code before any LLM wake. */
  readonly autopilot: SilasAutopilotConfig;
}

/** One rule family's mode. `dry-run` records the decision and makes no
 * call; `enforce` performs exactly one call; `off` does neither. */
export type SilasAutopilotRuleMode = 'off' | 'dry-run' | 'enforce';

/**
 * Silas autopilot policy (issue #243). `enabled` is the global kill switch
 * — default OFF, so no autopilot decision is recorded or acted on until an
 * owner turns it on. `rules` overlays per-family modes on the `dry-run`
 * default: enabling the autopilot never enforces a family by itself.
 */
export interface SilasAutopilotConfig {
  readonly enabled: boolean;
  readonly rules: Readonly<Record<string, SilasAutopilotRuleMode>>;
}

export const DEFAULT_SILAS_AUTOPILOT_CONFIG: SilasAutopilotConfig = { enabled: false, rules: {} };

export const DEFAULT_SILAS_CONFIG: SilasConfig = {
  enabled: true,
  sweepIntervalMs: 300_000,
  pollIntervalMs: 60_000,
  stallThresholdMs: 1_800_000,
  unchangedRewakeMs: 21_600_000,
  directiveAt: 2,
  rebriefAt: 3,
  escalateAt: 4,
  autopilot: DEFAULT_SILAS_AUTOPILOT_CONFIG,
};

/** Provider pacing is independent of resident-session [concurrency].
 * Admission caps ship enabled and unlimited; explicit enabled=false disables
 * both admission and automatic rate-limit retry. Provider-keyed signatures
 * match error text only, not the CLI or adapter brand. */
export interface PacingProviderOverride {
  /** Extra case-insensitive regex bodies classified as rate-limit class,
   * matched against the runtime error text alongside the generic 429-family
   * signatures. Signatures are global text signatures, not scoped per
   * provider. */
  readonly rateLimitPatterns: readonly string[];
}

export interface PacingConfig {
  /** Master switch (enabled by default). Off = no automatic retry and no caps (current
   * behavior). */
  readonly enabled: boolean;
  /** FIFO cap on concurrent minion turns; 0 = unlimited (the shipped
   * default — behavior-preserving). */
  readonly maxConcurrentMinions: number;
  /** FIFO cap on combined Perkins review turns (lead + lenses); 0 =
   * unlimited (the shipped default). */
  readonly maxConcurrentReviewTurns: number;
  /** Backoff base between automatic retries; doubles per attempt, with
   * additive jitter, clamped by backoffMaxMs. */
  readonly backoffBaseMs: number;
  /** Upper bound on any single automatic-retry delay. */
  readonly backoffMaxMs: number;
  /** Automatic retries per rate-limit incident before the failure stops to
   * the existing supervisor ladder + Gru's machine queue. 0 = no automatic
   * retry. */
  readonly maxAutoRetries: number;
  /** Provider-keyed extra rate-limit signatures (global text signatures). */
  readonly providers: Readonly<Record<string, PacingProviderOverride>>;
}

export const DEFAULT_PACING_CONFIG: PacingConfig = {
  enabled: true,
  maxConcurrentMinions: 0,
  maxConcurrentReviewTurns: 0,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  maxAutoRetries: 5,
  providers: {},
};

/** Provider-recovery sensor policy (owner-approved 2026-09-28,
 * owner-approval.json). The sensor watches EXPLICIT temporary provider
 * waits on supported routes and resumes approved work through Silas once
 * the provider returns — no owner polling or ACKs for those waits.
 * Split defaults (owner decision 2026-10-15): the native Claude route is ON
 * (`claudeNative`); GLM/Codex stay off until the owner sets `enabled`. */
export interface ProviderRecoveryConfig {
  /** Switch for the GLM/Codex routes. False (the default) = no waits
   * recorded, no probes, no wakes for them — inert until the owner enables
   * it. It never covers the native Claude route (see `claudeNative`). */
  readonly enabled: boolean;
  /** Automatic recovery for claude-code lanes on the native claude.ai login
   * (read-only usage-endpoint checks, never generation). The ONLY switch for
   * that route, independent of `enabled` either way. ON by default (owner
   * decision 2026-10-15); false leaves Claude quota walls to Gru. */
  readonly claudeNative: boolean;
  /** Sensor tick: how often routes are re-examined. The check cadence
   * itself is bounded below by cadenceMinMs. */
  readonly tickIntervalMs: number;
  /** Minimum spacing between checks on one route (approval pin: 300 s;
   * config may only raise it). */
  readonly cadenceMinMs: number;
  /** Maximum probe attempts per rolling hour per route (approval pin:
   * 12; config may only lower it). */
  readonly maxAttemptsPerHour: number;
  /** Backoff base between failed probes (transport/tool failures);
   * doubles per consecutive failure up to probeBackoffMaxMs. */
  readonly probeBackoffBaseMs: number;
  /** Backoff cap between failed probes. */
  readonly probeBackoffMaxMs: number;
  /** Consecutive false recoveries (recovery observed, continuation
   * re-hit the wall) before escalating to Gru and suspending the route. */
  readonly falseRecoveryEscalateAt: number;
  /** Route probe suspension after a false-recovery escalation. */
  readonly suspensionMs: number;
  /** Upper bound honored for a trustworthy provider Retry-After hint
   * (longer hints clamp to the cadence policy, never extend past this). */
  readonly retryAfterMaxMs: number;
  /** Bounded finite timeout for one probe I/O (generation or metadata
   * read); also bounds the pre-I/O reservation expiry. */
  readonly probeTimeoutMs: number;
  /** GLM bounded generation fallback (≤64 output tokens, no history/tools,
   * no hidden retries). The owner overlay keeps it DISABLED in production:
   * false (the default) means GLM waits never run a generation probe —
   * checks fail closed until a documented readiness endpoint exists. */
  readonly glmGenerationFallback: boolean;
}

export const DEFAULT_PROVIDER_RECOVERY_CONFIG: ProviderRecoveryConfig = {
  enabled: false,
  claudeNative: true,
  tickIntervalMs: 30_000,
  cadenceMinMs: 300_000,
  maxAttemptsPerHour: 12,
  probeBackoffBaseMs: 60_000,
  probeBackoffMaxMs: 1_800_000,
  falseRecoveryEscalateAt: 3,
  suspensionMs: 21_600_000,
  retryAfterMaxMs: 3_600_000,
  probeTimeoutMs: 30_000,
  glmGenerationFallback: false,
};

/** Hard floors from the owner approval — config may tighten, never
 * loosen, the probe policy pins. */
export const PROVIDER_RECOVERY_CADENCE_FLOOR_MS = 300_000;
export const PROVIDER_RECOVERY_MAX_ATTEMPTS_PER_HOUR_CAP = 12;

/** Verification scheduler policy (contention fix 2026-09-22): lanes request
 * verification runs through the service (POST /api/verify); the scheduler owns
 * the machine's GLOBAL test budget so co-tenant lanes cannot oversubscribe it.
 * One shared budget, FIFO queue, recorded evidence for review. */
export interface VerifyConfig {
  /** Concurrent verification runs across ALL lanes; further requests queue
   * FIFO. Default 1 keeps full suites from starving each other. */
  readonly maxConcurrent: number;
  /** Total concurrent test workers across runs; 0 = auto (cores - 2). */
  readonly workerBudget: number;
  /** How long a queued request may wait before failing loud (never a silent
   * hang) — the timeout lands on the lane and in the ledger. */
  readonly lockWaitTimeoutMs: number;
  /** Wall-clock cap per run; the process group is terminated on expiry. */
  readonly runTimeoutMs: number;
}

export const DEFAULT_VERIFY_CONFIG: VerifyConfig = {
  maxConcurrent: 1,
  workerBudget: 0,
  lockWaitTimeoutMs: 900_000,
  runTimeoutMs: 1_800_000,
};

export interface ConcurrencyConfig {
  /** Live non-core worker sessions across all jobs, including idle sessions. */
  readonly maxWorkers: number;
}

export const DEFAULT_CONCURRENCY_CONFIG: ConcurrencyConfig = { maxWorkers: 4 };
export const DEFAULT_REVIEW_CHILDREN = 2;
/** Explicit finite tool-batch bound; higher settings are rejected at load time
 * (review-gated, like the max_workers >= 2 requirement: both bounds govern
 * the review path only). */
export const MAX_REVIEW_CHILDREN = 32;
/** Documented finite sanity ceiling for resident workers: a typo must fail
 * load with an actionable bound, not silently oversubscribe the host. */
export const MAX_RESIDENT_WORKERS = 128;

/** Review gate policy (Perkins primary; bmad-review fallback gate per the
 * 2026-09-20 amendment, fork-3). */
export interface ReviewConfig {
  /** false routes every review request to the installed bmad-review fallback
   * gate (full gate semantics: host triage, fix directives, bounded re-review;
   * only an exact-head Perkins READY can authorize a merge, and merge stays
   * user-held). true keeps Perkins as the primary gate behind the four-leg
   * pre-flight capability check. A failed pre-flight is always reported, never
   * a silent downgrade. */
  readonly enabled: boolean;
  /** Maximum simultaneously resident lens children within the global pool. */
  readonly maxConcurrentChildren: number;
}

export interface JevConfig {
  readonly enabled: boolean;
  readonly model: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
}

/** One `[decisions.providers.<name>]` table: the full profile (issue #222).
 * Protocol, endpoint, model, credential slot and timeout are all required;
 * `input_price_per_mtok` is optional (systemone cost fallback). */
export interface DecisionProviderTable {
  readonly protocol: 'openrouter-decisions' | 'systemone';
  readonly endpoint: string;
  readonly model: string;
  readonly credential: string;
  readonly timeoutMs: number;
  readonly inputPricePerMtok: number;
}

export interface DecisionThresholdConfig {
  readonly act: number;
  readonly confirm: number;
  readonly requireConfirmOnAct: boolean;
}

/** One normalized `[decisions.surfaces.<surface>]` entry (issue #223).
 * `provider` omitted → the default profile (today's routing, unchanged).
 * `mode` omitted → the surface keeps its pre-#223 behavior (the provider's
 * answer, deterministic fallback) with NO enforce gate: the gate protects
 * an operator's explicit switch, never a legacy default. */
export interface DecisionSurfaceConfig {
  readonly provider?: string;
  readonly mode?: SurfaceMode;
}

export interface DecisionsConfig {
  readonly jev: JevConfig;
  /** User-defined/overriding provider profiles; built-ins are merged in by
   * {@link effectiveDecisionProviders}. */
  readonly providers: Readonly<Record<string, DecisionProviderTable>>;
  /** Per-surface routing and mode (issue #223): surface name → the profile
   * it routes to and the off/shadow/enforce mode it runs in. */
  readonly surfaces: Readonly<Record<string, DecisionSurfaceConfig>>;
  readonly thresholds: Readonly<{
    read_only: DecisionThresholdConfig;
    operational: DecisionThresholdConfig;
    destructive: DecisionThresholdConfig;
  }>;
}

/** The profile every surface routes to unless `[decisions.surfaces]` says
 * otherwise; the legacy `[decisions.jev]` block keeps feeding it. */
export const DEFAULT_DECISION_PROFILE = 'openrouter-jev';

const TYPESAFE_DIRECT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const LOCAL_SYSTEMONE_ENDPOINT = 'http://127.0.0.1:8088/v1/systemone';

/** The three built-in profiles, before user overrides (issue #222). The
 * `openrouter-jev` entry shown here is superseded by the legacy
 * `[decisions.jev]` block's model/endpoint/timeout when that block sets
 * them — see {@link effectiveDecisionProviders}. */
export function builtinDecisionProviders(jev: JevConfig): Record<string, DecisionProviderTable> {
  return {
    [DEFAULT_DECISION_PROFILE]: {
      protocol: 'openrouter-decisions',
      endpoint: jev.endpoint,
      model: jev.model,
      credential: 'openrouter',
      timeoutMs: jev.timeoutMs,
      inputPricePerMtok: 0.042,
    },
    'typesafe-direct': {
      protocol: 'systemone',
      endpoint: TYPESAFE_DIRECT_ENDPOINT,
      model: 'jev-latest',
      credential: 'typesafe',
      timeoutMs: jev.timeoutMs,
      inputPricePerMtok: 0.042,
    },
    local: {
      protocol: 'systemone',
      endpoint: LOCAL_SYSTEMONE_ENDPOINT,
      model: 'laya-421m',
      credential: 'none',
      timeoutMs: jev.timeoutMs,
      inputPricePerMtok: 0,
    },
  };
}

/** The effective profile set: built-ins (with the legacy `[decisions.jev]`
 * block feeding `openrouter-jev`), overlaid by `[decisions.providers]`.
 * Pure and total: every consumer (runtime, CLI, docs) reads routing from
 * this one map, which is prototype-free so reserved names (`__proto__`,
 * `toString`) behave as ordinary profile names. Throws
 * ConfigError-shaped profile errors on an invalid merge — callers degrade
 * loudly, never silently. */
export function effectiveDecisionProviders(
  config: DecisionsConfig,
): Record<string, DecisionProviderTable> {
  const merged: Record<string, DecisionProviderTable> = Object.create(null);
  Object.assign(merged, builtinDecisionProviders(config.jev));
  for (const [name, table] of Object.entries(config.providers)) {
    merged[name] = table;
  }
  return merged;
}

export const DEFAULT_DECISIONS_CONFIG: DecisionsConfig = {
  jev: {
    enabled: false,
    model: '~typesafe/jev-latest',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    timeoutMs: 5_000,
  },
  providers: {},
  surfaces: {},
  thresholds: {
    read_only: { act: 0.6, confirm: 0.4, requireConfirmOnAct: false },
    operational: { act: 0.75, confirm: 0.55, requireConfirmOnAct: false },
    destructive: { act: 0.85, confirm: 0.7, requireConfirmOnAct: true },
  },
};

export interface GruCommandConfig {
  readonly workspaceRoot: string;
  /** Explicit direct-child repository names; absent in older files means none. */
  readonly managedRepos: readonly string[];
  readonly dataDir: string;
  readonly server: ServerConfig;
  readonly auth: AuthConfig;
  readonly runtimes: RuntimesConfig;
  readonly models: ModelsConfig;
  readonly thinking: ThinkingConfig;
  readonly supervision: SupervisionConfig;
  readonly logging: LoggingConfig;
  readonly chat: ChatConfig;
  readonly worktrees: WorktreesConfig;
  readonly dispatch: DispatchConfig;
  readonly lessons: LessonsConfig;
  readonly silas: SilasConfig;
  readonly providerRecovery: ProviderRecoveryConfig;
  readonly vector: VectorConfig;
  readonly onboarding: OnboardingConfig;
  readonly roll: RollConfig;
  readonly concurrency: ConcurrencyConfig;
  readonly review: ReviewConfig;
  readonly verify: VerifyConfig;
  readonly pacing: PacingConfig;
  readonly decisions: DecisionsConfig;
  /** Absolute path the config was loaded from; null when running on pure defaults. */
  readonly sourceFile: string | null;
  /** Absolute per-instance directory holding config, identity, logs, sessions. */
  readonly instanceDir: string;
}

/** Fully-resolved model & thinking policy for one spawn (SPEC ruling 16). */
export interface SpawnPolicy {
  /** "default" (runtime's own) or an explicit "provider/model" string. */
  readonly model: string;
  /** "default" (runtime's own) or an explicit level name. */
  readonly thinkingLevel: string;
  /** claude-code only: runtime-agnostic [models]/[thinking] values that
   * resolution passed over (pi references: another provider's model, or a
   * thinking level the claude CLI does not accept). */
  readonly passedOver?: readonly { readonly tier: string; readonly ref: string }[];
}

/** Thinking levels the claude CLI accepts via --effort (fail-loud on others
 * at spawn). The single source for the adapter, resolution and docs. */
export const CLAUDE_CODE_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;

/** Thinking levels pi's session API accepts (fail-loud on others at spawn).
 * The single source for resolution, review identity and docs. */
export const PI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Claude Code is always Anthropic (owner ruling 2026-10-15). A reference in
 * the runtime-agnostic [models] tiers applies to claude-code only when it
 * names no provider, the `anthropic` provider, or carries an Anthropic
 * cloud-route id SHAPE: a Bedrock id ("anthropic.…", "us.anthropic.…",
 * "us-gov.anthropic.…") or a Vertex id ("claude-…@YYYYMMDD"). Any other provider — resellers serving
 * Claude under their own ids ("github-copilot/claude-sonnet-4.6") included —
 * makes it a pi reference, which claude-code resolution passes over. Shapes,
 * never model names. Explicit [runtimes.claude-code] entries and spawn
 * overrides are never filtered.
 */
export function appliesToClaudeCode(ref: string): boolean {
  const slash = ref.indexOf('/');
  if (slash < 0) return true;
  if (ref.slice(0, slash) === 'anthropic') return true;
  const id = ref.slice(slash + 1);
  return /^(?:[a-z]+(?:-[a-z]+)*\.)?anthropic\.[a-z0-9.:-]+$/u.test(id) || /^claude-[a-z0-9-]+@\d{8}$/u.test(id);
}

function normalizeSentinel(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return MODEL_DEFAULT_SENTINEL;
  return value;
}

/**
 * Resolve the spawn policy for a role on a runtime: spawn options beat
 * per-runtime-per-role, which beats per-role, which beats per-runtime,
 * which beats the global default (most specific wins). An explicit
 * "default" SENTINEL at a narrower tier PINS — it shadows wider tiers
 * (lets you un-set a global per runtime); "" is treated as "default"
 * (E1 configs with an empty models.default keep booting identically).
 */
export function resolveSpawnPolicy(
  config: GruCommandConfig,
  runtimeId: RuntimeId,
  role: Role,
  overrides: { model?: string; thinkingLevel?: string } = {},
): SpawnPolicy {
  const policy = config.runtimes.policies[runtimeId];
  const runtimeRole = policy?.roles[role];
  const passedOver: { tier: string; ref: string }[] = [];
  // The runtime-agnostic tiers hold pi references in a pi-first config:
  // claude-code passes over the ones naming another provider.
  const shared = (tier: string, ref: string | undefined): string | undefined => {
    if (ref === undefined || runtimeId !== 'claude-code' || appliesToClaudeCode(ref)) return ref;
    passedOver.push({ tier, ref });
    return undefined;
  };
  const model =
    overrides.model !== undefined
      ? overrides.model
      : runtimeRole?.model ?? shared(`models.roles.${role}`, config.models.roles[role]) ?? policy?.model ??
        shared('models.default', config.models.default);
  // A pi-only thinking level (e.g. "minimal") in the shared tiers would fail
  // every claude-code spawn: pass over it exactly like a pi model ref. Only a
  // level pi accepts and the claude CLI does not is a pi reference — any
  // other value (a typo) still reaches the adapter's fail-loud check.
  const sharedThinking = (tier: string, level: string | undefined): string | undefined => {
    if (level === undefined || runtimeId !== 'claude-code' ||
      !(PI_THINKING_LEVELS as readonly string[]).includes(level) ||
      (CLAUDE_CODE_THINKING_LEVELS as readonly string[]).includes(level)) return level;
    passedOver.push({ tier, ref: level });
    return undefined;
  };
  const thinkingLevel =
    overrides.thinkingLevel !== undefined
      ? overrides.thinkingLevel
      : runtimeRole?.thinkingLevel ??
        sharedThinking(`thinking.roles.${role}`, config.thinking.roles[role]) ??
        policy?.thinkingLevel ??
        sharedThinking('thinking.default', config.thinking.default);
  return {
    model: normalizeSentinel(model),
    thinkingLevel: normalizeSentinel(thinkingLevel),
    ...(passedOver.length > 0 ? { passedOver } : {}),
  };
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly field?: string,
  ) {
    super(field ? `${message} (file: ${file}, field: ${field})` : `${message} (file: ${file})`);
    this.name = 'ConfigError';
  }
}

const ENV_INSTANCE_DIR = 'GRU_COMMAND_HOME';

export function instanceDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_INSTANCE_DIR];
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new ConfigError(
        `${ENV_INSTANCE_DIR} must be an absolute path, got: ${override}`,
        override,
      );
    }
    return override;
  }
  return join(homedir(), '.gru-command');
}

export function configPathFor(instanceDir: string): string {
  return join(instanceDir, 'config.toml');
}

/** Parse the GRU_SERVICE_PORT override; null when unset. Fail loud on junk. */
function servicePortOverride(env: NodeJS.ProcessEnv, file: string): number | null {
  const raw = env[SERVICE_PORT_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(
      `${SERVICE_PORT_ENV} must be an integer between 0 and 65535 (0 = ephemeral), got: ${raw}`,
      file,
      SERVICE_PORT_ENV,
    );
  }
  return port;
}

export function expandTilde(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

const TOP_LEVEL_KEYS = [
  'workspace_root',
  'managed_repos',
  'data_dir',
  'server',
  'auth',
  'runtimes',
  'models',
  'thinking',
  'supervision',
  'logging',
  'chat',
  'worktrees',
  'dispatch',
  'lessons',
  'silas',
  'provider_recovery',
  'vector',
  'onboarding',
  'roll',
  'concurrency',
  'review',
  'verify',
  'pacing',
  'decisions',
] as const;

/** Sentinel meaning "the runtime harness's own configured default" (SPEC ruling 16). */
export const MODEL_DEFAULT_SENTINEL = 'default';

function isPlainObject(value: unknown): value is Record<string, TomlPrimitive> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  // TOML dates/times parse to Date-like class instances, not tables; without
  // this check they slip through as silently-empty tables.
  return Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(
  value: unknown,
  file: string,
  field: string,
  opts: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new ConfigError(
      `${field} must be a string, got ${typeof value}`,
      file,
      field,
    );
  }
  if (!opts.allowEmpty && value.trim() === '') {
    throw new ConfigError(`${field} must not be empty`, file, field);
  }
  return value;
}

function requireTable(
  value: unknown,
  file: string,
  field: string,
): Record<string, TomlPrimitive> {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${field} must be a table`, file, field);
  }
  return value;
}

function readRoleTable<T extends string>(
  value: unknown,
  file: string,
  field: string,
  validateValue: (v: unknown, file: string, f: string) => T,
): Partial<Record<Role, T>> {
  const table = requireTable(value, file, field);
  const out: Partial<Record<Role, T>> = {};
  for (const [key, val] of Object.entries(table)) {
    if (!(ROLES as readonly string[]).includes(key)) {
      throw new ConfigError(
        `unknown role \`${key}\` (valid roles: ${ROLES.join(', ')})`,
        file,
        `${field}.${key}`,
      );
    }
    out[key as Role] = validateValue(val, file, `${field}.${key}`);
  }
  return out;
}

function validateRuntimeId(value: unknown, file: string, field: string): RuntimeId {
  const id = requireString(value, file, field);
  if (!(RUNTIME_IDS as readonly string[]).includes(id)) {
    throw new ConfigError(
      `unknown runtime \`${id}\` (valid runtimes: ${RUNTIME_IDS.join(', ')})`,
      file,
      field,
    );
  }
  return id as RuntimeId;
}

/** A Vector decision mode; anything else names the valid set (#351). */
function requireVectorMode(value: unknown, file: string, field: string): VectorMode {
  if (typeof value !== 'string' || !(VECTOR_MODES as readonly string[]).includes(value)) {
    throw new ConfigError(`${field} must be one of ${VECTOR_MODES.map((mode) => `"${mode}"`).join(', ')}, got: ${JSON.stringify(value)}`, file, field);
  }
  return value as VectorMode;
}

function requireBool(value: unknown, file: string, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${field} must be a boolean, got ${typeof value}`, file, field);
  }
  return value;
}

function requirePositiveInt(value: unknown, file: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `${field} must be a positive integer, got: ${String(value)}`,
      file,
      field,
    );
  }
  // Integers beyond the safe range are representable but lose exactness;
  // they are rejected with their own actionable message.
  if (!Number.isSafeInteger(value)) {
    throw new ConfigError(
      `${field} exceeds the maximum safe integer (2^53 - 1); use a bounded value, got: ${String(value)}`,
      file,
      field,
    );
  }
  return value;
}

function requireNonNegativeInt(value: unknown, file: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(
      `${field} must be a non-negative integer, got: ${String(value)}`,
      file,
      field,
    );
  }
  return value;
}

/** Node clamps timer delays above 2^31 − 1 ms down to 1 ms, which would
 * turn a long periodic trigger into a 1 ms tick storm. Refuse such
 * intervals at the config boundary instead of failing at runtime. */
function requireTimerInterval(value: unknown, file: string, field: string): number {
  const ms = requireNonNegativeInt(value, file, field);
  const TIMER_CEILING_MS = 2_147_483_647;
  if (ms > TIMER_CEILING_MS) {
    throw new ConfigError(
      `${field} exceeds Node's timer ceiling (${TIMER_CEILING_MS} ms ≈ 24.8 days), got: ${ms} — longer delays clamp to 1 ms and would storm; use a smaller interval`,
      file,
      field,
    );
  }
  return ms;
}

function requireNonNegativeNumber(value: unknown, file: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${field} must be a non-negative finite number`, file, field);
  }
  return value;
}

/** `[worktrees] reclaim_mode` (#427 PR 3); absent is `automatic`. */
function requireReclaimMode(value: unknown, file: string): ReclaimMode {
  if (value === undefined) return 'automatic';
  if (typeof value !== 'string' || !(RECLAIM_MODES as readonly string[]).includes(value)) {
    throw new ConfigError(`worktrees.reclaim_mode must be one of ${RECLAIM_MODES.map((entry) => `"${entry}"`).join(', ')}, got: ${JSON.stringify(value)}`, file, 'worktrees.reclaim_mode');
  }
  return value as ReclaimMode;
}

function requireUnitNumber(value: unknown, file: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ConfigError(`${field} must be a finite number between 0 and 1`, file, field);
  }
  return value;
}

function requireNotifyWakeMode(value: unknown, file: string, field: string): NotifyWakeMode {
  const mode = requireString(value, file, field);
  if (!isNotifyWakeMode(mode)) {
    throw new ConfigError(
      `unknown wake policy \`${mode}\` (valid: ${NOTIFY_WAKE_MODES.join(', ')})`,
      file,
      field,
    );
  }
  return mode;
}

function requireWakeMinSeverity(value: unknown, file: string, field: string): WakeMinSeverity {
  const severity = requireString(value, file, field);
  if (!isWakeMinSeverity(severity)) {
    throw new ConfigError(
      `unknown wake severity floor \`${severity}\` (valid: ${WAKE_MIN_SEVERITIES.join(', ')})`,
      file,
      field,
    );
  }
  return severity;
}

/** Validate the operator's quiet-hours window. The parsing rule is stated
 * once, in wake-policy (`parseQuietHours`), so config and policy cannot
 * drift; a bad window refuses boot rather than silently disabling the
 * guard. */
function requireQuietHours(value: unknown, file: string, field: string): QuietHours | null {
  const text = requireString(value, file, field, { allowEmpty: true });
  try {
    return parseQuietHours(text);
  } catch (error) {
    throw new ConfigError((error as Error).message, file, field);
  }
}

function isInsideOrEqual(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Distinguish "no config file" (boot on defaults) from a broken config
 * path: a dangling symlink must fail loud, not silently vanish.
 */
function configState(file: string): 'present' | 'absent' {
  try {
    statSync(file);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ConfigError(`cannot stat config file: ${code ?? String(error)}`, file);
    }
    try {
      lstatSync(file);
    } catch {
      return 'absent';
    }
    throw new ConfigError(
      'config path is a dangling symlink — fix or remove it (refusing to silently boot on defaults)',
      file,
    );
  }
}

/**
 * Load and validate the instance configuration.
 *
 * Fail-loud contract: any parse or schema error throws {@link ConfigError}
 * naming the file and the offending field. A missing config file is not an
 * error — the service boots on documented defaults.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): GruCommandConfig {
  const instanceDir = instanceDirFromEnv(env);
  const file = configPathFor(instanceDir);

  const defaultWorkspaceRoot = join(home, 'code');
  let workspaceRoot = defaultWorkspaceRoot;
  let managedRepos: readonly string[] = [];
  let dataDir = instanceDir;
  let server: ServerConfig = { host: '127.0.0.1', port: DEFAULT_INSTANCE_PORT };
  let auth: AuthConfig = { token: '' };
  let runtimes: RuntimesConfig = { default: 'pi', roles: {}, policies: {} };
  let models: ModelsConfig = { default: MODEL_DEFAULT_SENTINEL, roles: {} };
  let thinking: ThinkingConfig = { default: MODEL_DEFAULT_SENTINEL, roles: {} };
  let supervision: SupervisionConfig = {
    enabled: true,
    turnSilenceMs: 900_000,
    restartWindowMs: 600_000,
    maxRestarts: 3,
    restartBackoffMs: 2_000,
  };
  let logging: LoggingConfig = { maxBytes: 10_485_760, keep: 5 };
  let chat: ChatConfig = {
    frameLogMaxBytes: 8_388_608,
    frameLogKeep: 3,
    // Owner ruling 2026-09-23: machine attention OPENS a turn by default;
    // 'never' remains available for strictly passive installs.
    notifyWake: 'action-required',
    wakeMinIntervalMs: 300_000,
    wakeMinSeverity: 'info',
    wakeQuietHours: null,
    wakeDeferCovered: true,
    mailboxReconcileIntervalMs: 300_000,
    morningDigestGapMs: 28_800_000,
  };
  let worktrees: WorktreesConfig | null = null;
  let dispatch: DispatchConfig = { bobIntervalMs: 0 };
  let lessons: LessonsConfig = DEFAULT_LESSONS_CONFIG;
  let silas: SilasConfig = DEFAULT_SILAS_CONFIG;
  let providerRecovery: ProviderRecoveryConfig = DEFAULT_PROVIDER_RECOVERY_CONFIG;
  let vector: VectorConfig = DEFAULT_VECTOR_CONFIG;
  let onboarding: OnboardingConfig = DEFAULT_ONBOARDING_CONFIG;
  let roll: RollConfig = DEFAULT_ROLL_CONFIG;
  let concurrency: ConcurrencyConfig = DEFAULT_CONCURRENCY_CONFIG;
  let review: ReviewConfig = { enabled: true, maxConcurrentChildren: DEFAULT_REVIEW_CHILDREN };
  let verify: VerifyConfig = DEFAULT_VERIFY_CONFIG;
  let pacing: PacingConfig = DEFAULT_PACING_CONFIG;
  let decisions: DecisionsConfig = DEFAULT_DECISIONS_CONFIG;
  let sourceFile: string | null = null;

  if (configState(file) === 'present') {
    sourceFile = file;
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      throw new ConfigError(
        errno !== undefined
          ? `cannot read config file: ${errno} — check permissions`
          : `cannot read config file: ${(error as Error).message}`,
        file,
      );
    }
    let raw: Record<string, TomlPrimitive>;
    try {
      raw = parse(text) as Record<string, TomlPrimitive>;
    } catch (error) {
      throw new ConfigError(
        `failed to parse TOML: ${(error as Error).message}`,
        file,
      );
    }
    for (const key of Object.keys(raw)) {
      if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
        throw new ConfigError(
          `unknown top-level key \`${key}\` (valid keys: ${TOP_LEVEL_KEYS.join(', ')})`,
          file,
          key,
        );
      }
    }
    if (raw['workspace_root'] !== undefined) {
      workspaceRoot = expandTilde(
        requireString(raw['workspace_root'], file, 'workspace_root'),
        home,
      );
    }
    if (raw['managed_repos'] !== undefined) {
      const value = raw['managed_repos'];
      if (!Array.isArray(value)) {
        throw new ConfigError('managed_repos must be an array of repository names', file, 'managed_repos');
      }
      const names = value.map((entry, index) => {
        const field = `managed_repos[${index}]`;
        if (typeof entry !== 'string') {
          throw new ConfigError(`${field} must be a string`, file, field);
        }
        const problem = managedRepoNameError(entry);
        if (problem !== null) {
          throw new ConfigError(
            `${field} ${problem} (got: ${JSON.stringify(displayManagedRepoName(entry))})`,
            file,
            field,
          );
        }
        return entry;
      });
      if (new Set(names).size !== names.length) {
        throw new ConfigError('managed_repos must not contain duplicate repository names', file, 'managed_repos');
      }
      managedRepos = names;
    }
    if (raw['data_dir'] !== undefined) {
      dataDir = expandTilde(requireString(raw['data_dir'], file, 'data_dir'), home);
    }
    if (raw['server'] !== undefined) {
      const table = requireTable(raw['server'], file, 'server');
      for (const key of Object.keys(table)) {
        if (!['host', 'port'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [server] (valid keys: host, port)`,
            file,
            `server.${key}`,
          );
        }
      }
      let host = server.host;
      let port = server.port;
      if (table['host'] !== undefined) {
        host = requireString(table['host'], file, 'server.host');
      }
      if (table['port'] !== undefined) {
        const p = table['port'];
        if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 65535) {
          throw new ConfigError(
            'server.port must be an integer between 0 and 65535 (0 = ephemeral)',
            file,
            'server.port',
          );
        }
        port = p;
      }
      server = { host, port };
    }
    if (raw['auth'] !== undefined) {
      const table = requireTable(raw['auth'], file, 'auth');
      for (const key of Object.keys(table)) {
        if (key !== 'token') {
          throw new ConfigError(
            `unknown key \`${key}\` in [auth] (valid key: token)`,
            file,
            `auth.${key}`,
          );
        }
      }
      if (table['token'] !== undefined) {
        auth = { token: requireString(table['token'], file, 'auth.token') };
      }
    }
    if (raw['runtimes'] !== undefined) {
      const table = requireTable(raw['runtimes'], file, 'runtimes');
      for (const key of Object.keys(table)) {
        const isMeta = ['default', 'roles'].includes(key);
        const isRuntimeId = (RUNTIME_IDS as readonly string[]).includes(key);
        if (!isMeta && !isRuntimeId) {
          throw new ConfigError(
            `unknown key \`${key}\` in [runtimes] (valid keys: default, roles, or a runtime id: ${RUNTIME_IDS.join(', ')})`,
            file,
            `runtimes.${key}`,
          );
        }
      }
      let def = runtimes.default;
      let roles = runtimes.roles;
      const policies: Partial<Record<RuntimeId, RuntimeModelPolicy>> = { ...runtimes.policies };
      if (table['default'] !== undefined) {
        def = validateRuntimeId(table['default'], file, 'runtimes.default');
      }
      if (table['roles'] !== undefined) {
        roles = readRoleTable(table['roles'], file, 'runtimes.roles', validateRuntimeId);
      }
      for (const runtimeId of RUNTIME_IDS) {
        if (table[runtimeId] !== undefined) {
          policies[runtimeId] = readRuntimePolicy(
            table[runtimeId],
            file,
            `runtimes.${runtimeId}`,
            runtimeId,
          );
        }
      }
      runtimes = { default: def, roles, policies };
    }
    if (raw['models'] !== undefined) {
      const table = requireTable(raw['models'], file, 'models');
      for (const key of Object.keys(table)) {
        if (!['default', 'roles'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [models] (valid keys: default, roles)`,
            file,
            `models.${key}`,
          );
        }
      }
      let def = models.default;
      let roles = models.roles;
      if (table['default'] !== undefined) {
        // Empty allowed: an empty value means the same as the "default"
        // sentinel (runtime's own model) — kept for E1 config compatibility.
        def = requireString(table['default'], file, 'models.default', {
          allowEmpty: true,
        });
      }
      if (table['roles'] !== undefined) {
        roles = readRoleTable(table['roles'], file, 'models.roles', (v, f, field2) =>
          requireString(v, f, field2),
        );
      }
      models = { default: def, roles };
    }
    if (raw['thinking'] !== undefined) {
      const table = requireTable(raw['thinking'], file, 'thinking');
      for (const key of Object.keys(table)) {
        if (!['default', 'roles'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [thinking] (valid keys: default, roles)`,
            file,
            `thinking.${key}`,
          );
        }
      }
      let def = thinking.default;
      let roles = thinking.roles;
      if (table['default'] !== undefined) {
        // Empty allowed: same as the "default" sentinel (runtime's own level).
        def = requireString(table['default'], file, 'thinking.default', {
          allowEmpty: true,
        });
      }
      if (table['roles'] !== undefined) {
        roles = readRoleTable(table['roles'], file, 'thinking.roles', (v, f, field2) =>
          requireString(v, f, field2),
        );
      }
      thinking = { default: def, roles };
    }
    if (raw['supervision'] !== undefined) {
      const table = requireTable(raw['supervision'], file, 'supervision');
      const VALID = ['enabled', 'turn_silence_ms', 'restart_window_ms', 'max_restarts', 'restart_backoff_ms'];
      for (const key of Object.keys(table)) {
        if (!VALID.includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [supervision] (valid keys: ${VALID.join(', ')})`,
            file,
            `supervision.${key}`,
          );
        }
      }
      supervision = {
        enabled: table['enabled'] !== undefined ? requireBool(table['enabled'], file, 'supervision.enabled') : supervision.enabled,
        turnSilenceMs: table['turn_silence_ms'] !== undefined ? requirePositiveInt(table['turn_silence_ms'], file, 'supervision.turn_silence_ms') : supervision.turnSilenceMs,
        restartWindowMs: table['restart_window_ms'] !== undefined ? requirePositiveInt(table['restart_window_ms'], file, 'supervision.restart_window_ms') : supervision.restartWindowMs,
        maxRestarts: table['max_restarts'] !== undefined ? requirePositiveInt(table['max_restarts'], file, 'supervision.max_restarts') : supervision.maxRestarts,
        restartBackoffMs: table['restart_backoff_ms'] !== undefined ? requirePositiveInt(table['restart_backoff_ms'], file, 'supervision.restart_backoff_ms') : supervision.restartBackoffMs,
      };
    }
    if (raw['logging'] !== undefined) {
      const table = requireTable(raw['logging'], file, 'logging');
      for (const key of Object.keys(table)) {
        if (!['max_bytes', 'keep'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [logging] (valid keys: max_bytes, keep)`,
            file,
            `logging.${key}`,
          );
        }
      }
      logging = {
        maxBytes: table['max_bytes'] !== undefined ? requirePositiveInt(table['max_bytes'], file, 'logging.max_bytes') : logging.maxBytes,
        keep: table['keep'] !== undefined ? requirePositiveInt(table['keep'], file, 'logging.keep') : logging.keep,
      };
    }
    if (raw['chat'] !== undefined) {
      const table = requireTable(raw['chat'], file, 'chat');
      const VALID = [
        'frame_log_max_bytes',
        'frame_log_keep',
        'notify_wake',
        'wake_min_interval_ms',
        'wake_min_severity',
        'wake_quiet_hours',
        'wake_defer_covered',
        'mailbox_reconcile_interval_ms',
        'morning_digest_gap_ms',
      ];
      for (const key of Object.keys(table)) {
        if (!VALID.includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [chat] (valid keys: ${VALID.join(', ')})`,
            file,
            `chat.${key}`,
          );
        }
      }
      chat = {
        frameLogMaxBytes: table['frame_log_max_bytes'] !== undefined ? requirePositiveInt(table['frame_log_max_bytes'], file, 'chat.frame_log_max_bytes') : chat.frameLogMaxBytes,
        frameLogKeep: table['frame_log_keep'] !== undefined ? requirePositiveInt(table['frame_log_keep'], file, 'chat.frame_log_keep') : chat.frameLogKeep,
        notifyWake:
          table['notify_wake'] !== undefined
            ? requireNotifyWakeMode(table['notify_wake'], file, 'chat.notify_wake')
            : chat.notifyWake,
        wakeMinIntervalMs:
          table['wake_min_interval_ms'] !== undefined
            ? requireNonNegativeInt(table['wake_min_interval_ms'], file, 'chat.wake_min_interval_ms')
            : chat.wakeMinIntervalMs,
        wakeMinSeverity:
          table['wake_min_severity'] !== undefined
            ? requireWakeMinSeverity(table['wake_min_severity'], file, 'chat.wake_min_severity')
            : chat.wakeMinSeverity,
        wakeQuietHours:
          table['wake_quiet_hours'] !== undefined
            ? requireQuietHours(table['wake_quiet_hours'], file, 'chat.wake_quiet_hours')
            : chat.wakeQuietHours,
        wakeDeferCovered:
          table['wake_defer_covered'] !== undefined
            ? requireBool(table['wake_defer_covered'], file, 'chat.wake_defer_covered')
            : chat.wakeDeferCovered,
        mailboxReconcileIntervalMs: table['mailbox_reconcile_interval_ms'] !== undefined
          ? requireTimerInterval(requirePositiveInt(table['mailbox_reconcile_interval_ms'], file, 'chat.mailbox_reconcile_interval_ms'), file, 'chat.mailbox_reconcile_interval_ms')
          : chat.mailboxReconcileIntervalMs,
        morningDigestGapMs:
          table['morning_digest_gap_ms'] !== undefined
            ? requireNonNegativeInt(table['morning_digest_gap_ms'], file, 'chat.morning_digest_gap_ms')
            : chat.morningDigestGapMs,
      };
    }
    if (raw['worktrees'] !== undefined) {
      const table = requireTable(raw['worktrees'], file, 'worktrees');
      for (const key of Object.keys(table)) {
        if (!['root', 'preserve_root', 'setup_timeout_ms', 'disk_budget_gb', 'min_free_disk_gb', 'reclaim_mode'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [worktrees] (valid keys: root, preserve_root, setup_timeout_ms, disk_budget_gb, min_free_disk_gb, reclaim_mode)`,
            file,
            `worktrees.${key}`,
          );
        }
      }
      worktrees = {
        root: table['root'] !== undefined ? expandTilde(requireString(table['root'], file, 'worktrees.root'), home) : '',
        preserveRoot: table['preserve_root'] !== undefined ? expandTilde(requireString(table['preserve_root'], file, 'worktrees.preserve_root'), home) : '',
        setupTimeoutMs: table['setup_timeout_ms'] !== undefined ? requirePositiveInt(table['setup_timeout_ms'], file, 'worktrees.setup_timeout_ms') : 120_000,
        diskBudgetGb: table['disk_budget_gb'] !== undefined ? requireNonNegativeNumber(table['disk_budget_gb'], file, 'worktrees.disk_budget_gb') : DEFAULT_DISK_BUDGET_GB,
        minFreeDiskGb: table['min_free_disk_gb'] !== undefined ? requireNonNegativeNumber(table['min_free_disk_gb'], file, 'worktrees.min_free_disk_gb') : DEFAULT_MIN_FREE_DISK_GB,
        reclaimMode: requireReclaimMode(table['reclaim_mode'], file),
      };
    }
    if (raw['dispatch'] !== undefined) {
      const table = requireTable(raw['dispatch'], file, 'dispatch');
      for (const key of Object.keys(table)) {
        if (!['bob_interval_ms'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [dispatch] (valid keys: bob_interval_ms)`,
            file,
            `dispatch.${key}`,
          );
        }
      }
      dispatch = {
        bobIntervalMs:
          table['bob_interval_ms'] !== undefined
            ? requireTimerInterval(table['bob_interval_ms'], file, 'dispatch.bob_interval_ms')
            : dispatch.bobIntervalMs,
      };
    }
    if (raw['lessons'] !== undefined) {
      const table = requireTable(raw['lessons'], file, 'lessons');
      const VALID = [
        'enabled',
        'dream_interval_ms',
        'dream_on_boot',
        'chapter_cap_bytes',
        'index_cap_bytes',
        'max_references',
      ];
      for (const key of Object.keys(table)) {
        if (!VALID.includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [lessons] (valid keys: ${VALID.join(', ')})`,
            file,
            `lessons.${key}`,
          );
        }
      }
      lessons = {
        enabled:
          table['enabled'] !== undefined
            ? requireBool(table['enabled'], file, 'lessons.enabled')
            : lessons.enabled,
        dreamIntervalMs:
          table['dream_interval_ms'] !== undefined
            ? requireTimerInterval(table['dream_interval_ms'], file, 'lessons.dream_interval_ms')
            : lessons.dreamIntervalMs,
        dreamOnBoot:
          table['dream_on_boot'] !== undefined
            ? requireBool(table['dream_on_boot'], file, 'lessons.dream_on_boot')
            : lessons.dreamOnBoot,
        chapterCapBytes:
          table['chapter_cap_bytes'] !== undefined
            ? requirePositiveInt(table['chapter_cap_bytes'], file, 'lessons.chapter_cap_bytes')
            : lessons.chapterCapBytes,
        indexCapBytes:
          table['index_cap_bytes'] !== undefined
            ? requirePositiveInt(table['index_cap_bytes'], file, 'lessons.index_cap_bytes')
            : lessons.indexCapBytes,
        maxReferences:
          table['max_references'] !== undefined
            ? requireNonNegativeInt(table['max_references'], file, 'lessons.max_references')
            : lessons.maxReferences,
      };
    }
    if (raw['silas'] !== undefined) {
      const table = requireTable(raw['silas'], file, 'silas');
      const VALID = ['enabled', 'sweep_interval_ms', 'unchanged_rewake_ms', 'poll_interval_ms', 'stall_threshold_ms', 'directive_at', 'rebrief_at', 'escalate_at', 'autopilot'];
      for (const key of Object.keys(table)) {
        if (!VALID.includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [silas] (valid keys: ${VALID.join(', ')})`,
            file,
            `silas.${key}`,
          );
        }
      }
      const directiveAt =
        table['directive_at'] !== undefined
          ? requirePositiveInt(table['directive_at'], file, 'silas.directive_at')
          : silas.directiveAt;
      const rebriefAt =
        table['rebrief_at'] !== undefined
          ? requirePositiveInt(table['rebrief_at'], file, 'silas.rebrief_at')
          : silas.rebriefAt;
      const escalateAt =
        table['escalate_at'] !== undefined
          ? requirePositiveInt(table['escalate_at'], file, 'silas.escalate_at')
          : silas.escalateAt;
      if (!(directiveAt < rebriefAt && rebriefAt < escalateAt)) {
        throw new ConfigError(
          `silas recurrence thresholds must strictly ascend (directive_at ${directiveAt} < rebrief_at ${rebriefAt} < escalate_at ${escalateAt})`,
          file,
          'silas.directive_at',
        );
      }
      silas = {
        enabled: table['enabled'] !== undefined ? requireBool(table['enabled'], file, 'silas.enabled') : silas.enabled,
        sweepIntervalMs: table['sweep_interval_ms'] !== undefined ? requireNonNegativeInt(table['sweep_interval_ms'], file, 'silas.sweep_interval_ms') : silas.sweepIntervalMs,
        pollIntervalMs: table['poll_interval_ms'] !== undefined ? requireNonNegativeInt(table['poll_interval_ms'], file, 'silas.poll_interval_ms') : silas.pollIntervalMs,
        stallThresholdMs: table['stall_threshold_ms'] !== undefined ? requirePositiveInt(table['stall_threshold_ms'], file, 'silas.stall_threshold_ms') : silas.stallThresholdMs,
        unchangedRewakeMs: table['unchanged_rewake_ms'] !== undefined ? requireNonNegativeInt(table['unchanged_rewake_ms'], file, 'silas.unchanged_rewake_ms') : silas.unchangedRewakeMs,
        directiveAt,
        rebriefAt,
        escalateAt,
        autopilot:
          table['autopilot'] !== undefined
            ? readSilasAutopilotConfig(table['autopilot'], file)
            : silas.autopilot,
      };
    }
    if (raw['provider_recovery'] !== undefined) {
      const table = requireTable(raw['provider_recovery'], file, 'provider_recovery');
      const VALID = [
        'enabled',
        'tick_interval_ms',
        'cadence_min_ms',
        'max_attempts_per_hour',
        'probe_backoff_base_ms',
        'probe_backoff_max_ms',
        'false_recovery_escalate_at',
        'suspension_ms',
        'retry_after_max_ms',
        'probe_timeout_ms',
        'glm_generation_fallback',
        'claude_native',
      ];
      for (const key of Object.keys(table)) {
        if (!VALID.includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [provider_recovery] (valid keys: ${VALID.join(', ')})`,
            file,
            `provider_recovery.${key}`,
          );
        }
      }
      const cadenceMinMs =
        table['cadence_min_ms'] !== undefined
          ? requirePositiveInt(table['cadence_min_ms'], file, 'provider_recovery.cadence_min_ms')
          : providerRecovery.cadenceMinMs;
      if (cadenceMinMs < PROVIDER_RECOVERY_CADENCE_FLOOR_MS) {
        throw new ConfigError(
          `provider_recovery.cadence_min_ms (${cadenceMinMs}) is below the approved floor ${PROVIDER_RECOVERY_CADENCE_FLOOR_MS} — the owner approval pins shared route checks to at least 300 s`,
          file,
          'provider_recovery.cadence_min_ms',
        );
      }
      const maxAttemptsPerHour =
        table['max_attempts_per_hour'] !== undefined
          ? requirePositiveInt(table['max_attempts_per_hour'], file, 'provider_recovery.max_attempts_per_hour')
          : providerRecovery.maxAttemptsPerHour;
      if (maxAttemptsPerHour > PROVIDER_RECOVERY_MAX_ATTEMPTS_PER_HOUR_CAP) {
        throw new ConfigError(
          `provider_recovery.max_attempts_per_hour (${maxAttemptsPerHour}) exceeds the approved cap ${PROVIDER_RECOVERY_MAX_ATTEMPTS_PER_HOUR_CAP} — the owner approval pins at most 12 attempts/hour/route`,
          file,
          'provider_recovery.max_attempts_per_hour',
        );
      }
      providerRecovery = {
        enabled: table['enabled'] !== undefined ? requireBool(table['enabled'], file, 'provider_recovery.enabled') : providerRecovery.enabled,
        tickIntervalMs: table['tick_interval_ms'] !== undefined ? requirePositiveInt(table['tick_interval_ms'], file, 'provider_recovery.tick_interval_ms') : providerRecovery.tickIntervalMs,
        cadenceMinMs,
        maxAttemptsPerHour,
        probeBackoffBaseMs: table['probe_backoff_base_ms'] !== undefined ? requirePositiveInt(table['probe_backoff_base_ms'], file, 'provider_recovery.probe_backoff_base_ms') : providerRecovery.probeBackoffBaseMs,
        probeBackoffMaxMs: table['probe_backoff_max_ms'] !== undefined ? requirePositiveInt(table['probe_backoff_max_ms'], file, 'provider_recovery.probe_backoff_max_ms') : providerRecovery.probeBackoffMaxMs,
        falseRecoveryEscalateAt: table['false_recovery_escalate_at'] !== undefined ? requirePositiveInt(table['false_recovery_escalate_at'], file, 'provider_recovery.false_recovery_escalate_at') : providerRecovery.falseRecoveryEscalateAt,
        suspensionMs: table['suspension_ms'] !== undefined ? requirePositiveInt(table['suspension_ms'], file, 'provider_recovery.suspension_ms') : providerRecovery.suspensionMs,
        retryAfterMaxMs: table['retry_after_max_ms'] !== undefined ? requirePositiveInt(table['retry_after_max_ms'], file, 'provider_recovery.retry_after_max_ms') : providerRecovery.retryAfterMaxMs,
        probeTimeoutMs: table['probe_timeout_ms'] !== undefined ? requirePositiveInt(table['probe_timeout_ms'], file, 'provider_recovery.probe_timeout_ms') : providerRecovery.probeTimeoutMs,
        glmGenerationFallback:
          table['glm_generation_fallback'] !== undefined
            ? requireBool(table['glm_generation_fallback'], file, 'provider_recovery.glm_generation_fallback')
            : providerRecovery.glmGenerationFallback,
        claudeNative:
          table['claude_native'] !== undefined
            ? requireBool(table['claude_native'], file, 'provider_recovery.claude_native')
            : providerRecovery.claudeNative,
      };
    }
    if (raw['vector'] !== undefined) {
      const table = requireTable(raw['vector'], file, 'vector');
      const VALID = ['enabled', 'raid_mode', 'fix_mode', 'plan_interval_ms', 'max_rounds', 'max_runs', 'max_raid_ms', 'max_raid_tokens', 'max_raids_per_day'];
      for (const key of Object.keys(table)) {
        if (!VALID.includes(key)) {
          throw new ConfigError(`unknown key \`${key}\` in [vector] (valid keys: ${VALID.join(', ')})`, file, `vector.${key}`);
        }
      }
      vector = {
        enabled: table['enabled'] !== undefined ? requireBool(table['enabled'], file, 'vector.enabled') : vector.enabled,
        raidMode: table['raid_mode'] !== undefined ? requireVectorMode(table['raid_mode'], file, 'vector.raid_mode') : vector.raidMode,
        fixMode: table['fix_mode'] !== undefined ? requireVectorMode(table['fix_mode'], file, 'vector.fix_mode') : vector.fixMode,
        planIntervalMs: table['plan_interval_ms'] !== undefined ? requireTimerInterval(table['plan_interval_ms'], file, 'vector.plan_interval_ms') : vector.planIntervalMs,
        maxRounds: table['max_rounds'] !== undefined ? requirePositiveInt(table['max_rounds'], file, 'vector.max_rounds') : vector.maxRounds,
        maxRuns: table['max_runs'] !== undefined ? requirePositiveInt(table['max_runs'], file, 'vector.max_runs') : vector.maxRuns,
        maxRaidMs: table['max_raid_ms'] !== undefined ? requireTimerInterval(table['max_raid_ms'], file, 'vector.max_raid_ms') : vector.maxRaidMs,
        maxRaidTokens: table['max_raid_tokens'] !== undefined ? requirePositiveInt(table['max_raid_tokens'], file, 'vector.max_raid_tokens') : vector.maxRaidTokens,
        maxRaidsPerDay: table['max_raids_per_day'] !== undefined ? requirePositiveInt(table['max_raids_per_day'], file, 'vector.max_raids_per_day') : vector.maxRaidsPerDay,
      };
      if (vector.maxRaidMs === 0) throw new ConfigError('vector.max_raid_ms must be positive (a raid always has a wall-clock cap)', file, 'vector.max_raid_ms');
      if (vector.maxRuns < VECTOR_MAX_RUNS_PER_ATTACK) {
        throw new ConfigError(`vector.max_runs must be at least ${String(VECTOR_MAX_RUNS_PER_ATTACK)}: one attack can need that many sandboxed runs (both controls, the attack, the baseline and the replay), so a smaller cap never attacks`, file, 'vector.max_runs');
      }
    }
    if (raw['onboarding'] !== undefined) {
      const table = requireTable(raw['onboarding'], file, 'onboarding');
      for (const key of Object.keys(table)) {
        if (key !== 'mode') throw new ConfigError(`unknown key \`${key}\` in [onboarding] (valid keys: mode)`, file, `onboarding.${key}`);
      }
      const mode = table['mode'];
      if (mode !== undefined && (typeof mode !== 'string' || !(ONBOARDING_MODES as readonly string[]).includes(mode))) {
        throw new ConfigError(`onboarding.mode must be one of ${ONBOARDING_MODES.map((entry) => `"${entry}"`).join(', ')}, got: ${JSON.stringify(mode)}`, file, 'onboarding.mode');
      }
      onboarding = { mode: (mode as OnboardingMode | undefined) ?? onboarding.mode };
    }
    if (raw['roll'] !== undefined) {
      const table = requireTable(raw['roll'], file, 'roll');
      for (const key of Object.keys(table)) {
        if (!['drain_timeout_ms'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [roll] (valid keys: drain_timeout_ms)`,
            file,
            `roll.${key}`,
          );
        }
      }
      roll = {
        drainTimeoutMs:
          table['drain_timeout_ms'] !== undefined
            ? requireNonNegativeInt(table['drain_timeout_ms'], file, 'roll.drain_timeout_ms')
            : roll.drainTimeoutMs,
      };
    }
    if (raw['concurrency'] !== undefined) {
      const table = requireTable(raw['concurrency'], file, 'concurrency');
      for (const key of Object.keys(table)) {
        if (key !== 'max_workers') throw new ConfigError(
          `unknown key \`${key}\` in [concurrency] (valid key: max_workers)`, file, `concurrency.${key}`,
        );
      }
      concurrency = {
        maxWorkers: table['max_workers'] !== undefined
          ? requirePositiveInt(table['max_workers'], file, 'concurrency.max_workers')
          : concurrency.maxWorkers,
      };
    }
    if (raw['review'] !== undefined) {
      const table = requireTable(raw['review'], file, 'review');
      for (const key of Object.keys(table)) {
        if (!['enabled', 'max_concurrent_children'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [review] (valid keys: enabled, max_concurrent_children)`,
            file,
            `review.${key}`,
          );
        }
      }
      review = {
        enabled:
          table['enabled'] !== undefined
            ? requireBool(table['enabled'], file, 'review.enabled')
            : review.enabled,
        maxConcurrentChildren: table['max_concurrent_children'] !== undefined
          ? requirePositiveInt(table['max_concurrent_children'], file, 'review.max_concurrent_children')
          : review.maxConcurrentChildren,
      };
    }
    if (raw['verify'] !== undefined) {
      const table = requireTable(raw['verify'], file, 'verify');
      const VALID = ['max_concurrent', 'worker_budget', 'lock_wait_timeout_ms', 'run_timeout_ms'];
      for (const key of Object.keys(table)) {
        if (!VALID.includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [verify] (valid keys: ${VALID.join(', ')})`,
            file,
            `verify.${key}`,
          );
        }
      }
      verify = {
        maxConcurrent:
          table['max_concurrent'] !== undefined
            ? requirePositiveInt(table['max_concurrent'], file, 'verify.max_concurrent')
            : verify.maxConcurrent,
        workerBudget:
          table['worker_budget'] !== undefined
            ? requireNonNegativeInt(table['worker_budget'], file, 'verify.worker_budget')
            : verify.workerBudget,
        lockWaitTimeoutMs:
          table['lock_wait_timeout_ms'] !== undefined
            ? requirePositiveInt(table['lock_wait_timeout_ms'], file, 'verify.lock_wait_timeout_ms')
            : verify.lockWaitTimeoutMs,
        runTimeoutMs:
          table['run_timeout_ms'] !== undefined
            ? requirePositiveInt(table['run_timeout_ms'], file, 'verify.run_timeout_ms')
            : verify.runTimeoutMs,
      };
    }
    if (raw['pacing'] !== undefined) {
      pacing = readPacingConfig(raw['pacing'], file, 'pacing', pacing);
    }
    if (raw['decisions'] !== undefined) {
      decisions = readDecisionsConfig(raw['decisions'], file, decisions);
    }
  }

  if (concurrency.maxWorkers > MAX_RESIDENT_WORKERS) {
    throw new ConfigError(`concurrency.max_workers must be <= ${MAX_RESIDENT_WORKERS} (documented resident sanity ceiling)`, file, 'concurrency.max_workers');
  }
  if (review.enabled && concurrency.maxWorkers < 2) {
    throw new ConfigError('Perkins requires concurrency.max_workers >= 2 for a lead and child', file, 'concurrency.max_workers');
  }
  if (review.enabled && review.maxConcurrentChildren > MAX_REVIEW_CHILDREN) {
    throw new ConfigError(`review.max_concurrent_children must be <= ${MAX_REVIEW_CHILDREN} (bounded lens tool batch)`, file, 'review.max_concurrent_children');
  }

  for (const [label, dir] of [
    ['workspace_root', workspaceRoot],
    ['data_dir', dataDir],
  ] as const) {
    if (!isAbsolute(dir)) {
      throw new ConfigError(`${label} must resolve to an absolute path, got: ${dir}`, file, label);
    }
  }

  // SPEC ruling 7: instance state NEVER lives inside the workspace root.
  // A purely lexical check is bypassable by symlinks and case-insensitive
  // filesystems — compare the realpath pair too when both paths exist on
  // disk (fresh installs without the directories fall back to lexical).
  const insideLexically = isInsideOrEqual(workspaceRoot, dataDir);
  let insideReally = false;
  try {
    insideReally = isInsideOrEqual(realpathSync(workspaceRoot), realpathSync(dataDir));
  } catch {
    // one or both paths not on disk yet — lexical verdict stands
  }
  if (insideLexically || insideReally) {
    throw new ConfigError(
      `data_dir must not live inside workspace_root (workspace_root: ${workspaceRoot}, data_dir: ${dataDir}) — SPEC ruling 7`,
      file,
      'data_dir',
    );
  }

  // The explicit env override wins over whatever the config file said —
  // the test/e2e harness's one sanctioned way to hand a spawned service a
  // port (src/service-port-guard.ts refuses un-overridden fixed ports from
  // a worktree checkout).
  const envPort = servicePortOverride(env, file);
  if (envPort !== null) server = { ...server, port: envPort };

  return {
    workspaceRoot: resolve(workspaceRoot),
    managedRepos,
    dataDir: resolve(dataDir),
    server,
    auth,
    runtimes,
    models,
    thinking,
    supervision,
    logging,
    chat,
    worktrees: {
      root: resolve(worktrees !== null && worktrees.root !== '' ? worktrees.root : join(dataDir, 'worktrees')),
      preserveRoot: resolve(
        worktrees !== null && worktrees.preserveRoot !== '' ? worktrees.preserveRoot : join(dataDir, 'worktree-preserves'),
      ),
      setupTimeoutMs: worktrees?.setupTimeoutMs ?? 120_000,
      diskBudgetGb: worktrees?.diskBudgetGb ?? DEFAULT_DISK_BUDGET_GB,
      minFreeDiskGb: worktrees?.minFreeDiskGb ?? DEFAULT_MIN_FREE_DISK_GB,
      reclaimMode: worktrees?.reclaimMode ?? 'automatic',
    },
    dispatch,
    lessons,
    silas,
    providerRecovery,
    vector,
    onboarding,
    roll,
    concurrency,
    review,
    verify,
    pacing,
    decisions,
    sourceFile,
    instanceDir,
  };
}

const PACING_KEYS = [
  'enabled',
  'max_concurrent_minions',
  'max_concurrent_review_turns',
  'backoff_base_ms',
  'backoff_max_ms',
  'max_auto_retries',
  'providers',
] as const;

/** Parse the `[silas.autopilot]` table (issue #243): the global kill
 * switch plus per-family modes. Both levels fail loud — an unknown rule id
 * or an unknown mode must never silently fall back to the dry-run default,
 * which is exactly the mistake a rollout relies on this parser to catch. */
function readSilasAutopilotConfig(value: unknown, file: string): SilasAutopilotConfig {
  const table = requireTable(value, file, 'silas.autopilot');
  const VALID = ['enabled', 'rules'];
  for (const key of Object.keys(table)) {
    if (!VALID.includes(key)) {
      throw new ConfigError(
        `unknown key \`${key}\` in [silas.autopilot] (valid keys: ${VALID.join(', ')})`,
        file,
        `silas.autopilot.${key}`,
      );
    }
  }
  const enabled =
    table['enabled'] !== undefined
      ? requireBool(table['enabled'], file, 'silas.autopilot.enabled')
      : DEFAULT_SILAS_AUTOPILOT_CONFIG.enabled;
  if (table['rules'] === undefined) return { enabled, rules: {} };
  const rulesTable = requireTable(table['rules'], file, 'silas.autopilot.rules');
  // Null-prototype map: a rule id like "__proto__" must land as an own
  // entry, never mutate the map's prototype or vanish silently.
  const rules: Record<string, SilasAutopilotRuleMode> = Object.create(null) as Record<
    string,
    SilasAutopilotRuleMode
  >;
  for (const [ruleId, mode] of Object.entries(rulesTable)) {
    if (!(SILAS_AUTOPILOT_RULE_IDS as readonly string[]).includes(ruleId)) {
      throw new ConfigError(
        `silas.autopilot.rules names \`${ruleId}\`, which is not an autopilot rule family ` +
          `(known: ${SILAS_AUTOPILOT_RULE_IDS.join(', ')})`,
        file,
        `silas.autopilot.rules.${ruleId}`,
      );
    }
    if (mode !== 'off' && mode !== 'dry-run' && mode !== 'enforce') {
      throw new ConfigError(
        `silas.autopilot.rules.${ruleId} must be one of "off", "dry-run", "enforce", got: ${JSON.stringify(mode)}`,
        file,
        `silas.autopilot.rules.${ruleId}`,
      );
    }
    rules[ruleId] = mode;
  }
  return { enabled, rules };
}

/** Parse a [pacing] table. Fail loud on unknown
 * keys, wrong types, non-compiling patterns, and an inverted backoff
 * ladder — a pacing misconfiguration must never silently disable or
 * distort the bounds. The section being present is the feature switch
 * unless an explicit `enabled = false` turns it off; this function only
 * ever runs when a section is present, so the default is `enabled: true`. */
function readPacingConfig(
  value: unknown,
  file: string,
  section: 'pacing',
  defaults: PacingConfig,
): PacingConfig {
  const table = requireTable(value, file, section);
  for (const key of Object.keys(table)) {
    if (!(PACING_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(
        `unknown key \`${key}\` in [${section}] (valid keys: ${PACING_KEYS.join(', ')})`,
        file,
        `${section}.${key}`,
      );
    }
  }
  // One canonical spelling per limit key (max_concurrent_minions,
  // max_concurrent_review_turns); unknown spellings fail loud above rather
  // than being silently accepted or aliased. A file that sets both is
  // therefore impossible to write.
  const enabled =
    table['enabled'] !== undefined ? requireBool(table['enabled'], file, `${section}.enabled`) : defaults.enabled;
  const maxConcurrentMinions = table['max_concurrent_minions'] !== undefined
    ? requireNonNegativeInt(table['max_concurrent_minions'], file, `${section}.max_concurrent_minions`)
    : defaults.maxConcurrentMinions;
  const maxConcurrentReviewTurns = table['max_concurrent_review_turns'] !== undefined
    ? requireNonNegativeInt(table['max_concurrent_review_turns'], file, `${section}.max_concurrent_review_turns`)
    : defaults.maxConcurrentReviewTurns;
  const backoffBaseMs =
    table['backoff_base_ms'] !== undefined
      ? requirePositiveInt(table['backoff_base_ms'], file, `${section}.backoff_base_ms`)
      : defaults.backoffBaseMs;
  const backoffMaxMs =
    table['backoff_max_ms'] !== undefined
      ? requirePositiveInt(table['backoff_max_ms'], file, `${section}.backoff_max_ms`)
      : defaults.backoffMaxMs;
  if (backoffBaseMs > backoffMaxMs) {
    throw new ConfigError(
      `${section}.backoff_base_ms (${backoffBaseMs}) must not exceed ${section}.backoff_max_ms (${backoffMaxMs})`,
      file,
      `${section}.backoff_base_ms`,
    );
  }
  let providers = defaults.providers;
  if (table['providers'] !== undefined) {
    const providersTable = requireTable(table['providers'], file, `${section}.providers`);
    // Null-prototype map: a provider id like "__proto__" must land as an
    // own entry, never mutate the map's prototype or vanish silently.
    const parsed: Record<string, PacingProviderOverride> = Object.create(null) as Record<
      string,
      PacingProviderOverride
    >;
    for (const [providerId, entry] of Object.entries(providersTable)) {
      if (providerId.trim() === '') {
        throw new ConfigError(
          `${section}.providers keys must be non-empty provider ids`,
          file,
          `${section}.providers`,
        );
      }
      const entryTable = requireTable(entry, file, `${section}.providers."${providerId}"`);
      for (const key of Object.keys(entryTable)) {
        if (key !== 'rate_limit_patterns') {
          throw new ConfigError(
            `unknown key \`${key}\` in [${section}.providers."${providerId}"] (valid keys: rate_limit_patterns)`,
            file,
            `${section}.providers."${providerId}".${key}`,
          );
        }
      }
      const rawPatterns = entryTable['rate_limit_patterns'];
      if (rawPatterns === undefined) {
        throw new ConfigError(
          `[${section}.providers."${providerId}"] must set rate_limit_patterns`,
          file,
          `${section}.providers."${providerId}"`,
        );
      }
      if (!Array.isArray(rawPatterns)) {
        throw new ConfigError(
          `${section}.providers."${providerId}".rate_limit_patterns must be an array of strings`,
          file,
          `${section}.providers."${providerId}".rate_limit_patterns`,
        );
      }
      const patterns = rawPatterns.map((pattern, index) => {
        const text = requireString(
          pattern,
          file,
          `${section}.providers."${providerId}".rate_limit_patterns[${index}]`,
        );
        try {
          new RegExp(text, 'i');
        } catch (error) {
          throw new ConfigError(
            `${section}.providers."${providerId}".rate_limit_patterns[${index}] is not a valid regex: ${(error as Error).message}`,
            file,
            `${section}.providers."${providerId}".rate_limit_patterns[${index}]`,
          );
        }
        return text;
      });
      parsed[providerId] = { rateLimitPatterns: patterns };
    }
    providers = parsed;
  }
  return {
    enabled,
    maxConcurrentMinions,
    maxConcurrentReviewTurns,
    backoffBaseMs,
    backoffMaxMs,
    maxAutoRetries:
      table['max_auto_retries'] !== undefined
        ? requireNonNegativeInt(table['max_auto_retries'], file, `${section}.max_auto_retries`)
        : defaults.maxAutoRetries,
    providers,
  };
}

function readDecisionThreshold(
  value: unknown,
  file: string,
  field: string,
  defaults: DecisionThresholdConfig,
): DecisionThresholdConfig {
  const table = requireTable(value, file, field);
  const valid = ['act', 'confirm', 'require_confirm_on_act'];
  for (const key of Object.keys(table)) {
    if (!valid.includes(key)) {
      throw new ConfigError(
        `unknown key \`${key}\` in [${field}] (valid keys: ${valid.join(', ')})`,
        file,
        `${field}.${key}`,
      );
    }
  }
  const result: DecisionThresholdConfig = {
    act: table['act'] !== undefined ? requireUnitNumber(table['act'], file, `${field}.act`) : defaults.act,
    confirm: table['confirm'] !== undefined ? requireUnitNumber(table['confirm'], file, `${field}.confirm`) : defaults.confirm,
    requireConfirmOnAct:
      table['require_confirm_on_act'] !== undefined
        ? requireBool(table['require_confirm_on_act'], file, `${field}.require_confirm_on_act`)
        : defaults.requireConfirmOnAct,
  };
  if (result.confirm >= result.act) {
    throw new ConfigError(
      `${field}.confirm (${result.confirm}) must be less than ${field}.act (${result.act})`,
      file,
      field,
    );
  }
  return result;
}

function readDecisionsConfig(
  value: unknown,
  file: string,
  defaults: DecisionsConfig,
): DecisionsConfig {
  const table = requireTable(value, file, 'decisions');
  for (const key of Object.keys(table)) {
    if (!['jev', 'providers', 'surfaces', 'thresholds'].includes(key)) {
      throw new ConfigError(
        `unknown key \`${key}\` in [decisions] (valid keys: jev, providers, surfaces, thresholds)`,
        file,
        `decisions.${key}`,
      );
    }
  }
  let jev = defaults.jev;
  if (table['jev'] !== undefined) {
    const jevTable = requireTable(table['jev'], file, 'decisions.jev');
    const valid = ['enabled', 'model', 'endpoint', 'timeout_ms'];
    for (const key of Object.keys(jevTable)) {
      if (!valid.includes(key)) {
        throw new ConfigError(
          `unknown key \`${key}\` in [decisions.jev] (valid keys: ${valid.join(', ')})`,
          file,
          `decisions.jev.${key}`,
        );
      }
    }
    jev = {
      enabled: jevTable['enabled'] !== undefined ? requireBool(jevTable['enabled'], file, 'decisions.jev.enabled') : jev.enabled,
      model: jevTable['model'] !== undefined ? requireString(jevTable['model'], file, 'decisions.jev.model') : jev.model,
      endpoint: jevTable['endpoint'] !== undefined ? requireString(jevTable['endpoint'], file, 'decisions.jev.endpoint') : jev.endpoint,
      timeoutMs: jevTable['timeout_ms'] !== undefined ? requirePositiveInt(jevTable['timeout_ms'], file, 'decisions.jev.timeout_ms') : jev.timeoutMs,
    };
  }
  // Provider profiles (issue #222). Each table is FULL (protocol, endpoint,
  // model, credential, timeout_ms; optional input_price_per_mtok) and is
  // validated against its protocol's endpoint/credential binding rules.
  // Prototype-free: a reserved name like `__proto__` stays an ordinary
  // profile name instead of silently mutating or vanishing.
  const providers: Record<string, DecisionProviderTable> = Object.create(null);
  if (table['providers'] !== undefined) {
    const providersTable = requireTable(table['providers'], file, 'decisions.providers');
    for (const name of Object.keys(providersTable)) {
      if (!Object.prototype.hasOwnProperty.call(providersTable, name)) continue;
      if (!/^[A-Za-z0-9_-]+$/u.test(name)) {
        throw new ConfigError(
          `provider profile name \`${name}\` must match [A-Za-z0-9_-]+`,
          file,
          `decisions.providers.${name}`,
        );
      }
      const profileTable = requireTable(providersTable[name], file, `decisions.providers.${name}`);
      const valid = ['protocol', 'endpoint', 'model', 'credential', 'timeout_ms', 'input_price_per_mtok'];
      for (const key of Object.keys(profileTable)) {
        if (!valid.includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [decisions.providers.${name}] (valid keys: ${valid.join(', ')})`,
            file,
            `decisions.providers.${name}.${key}`,
          );
        }
      }
      const missing = ['protocol', 'endpoint', 'model', 'credential', 'timeout_ms'].filter((key) => profileTable[key] === undefined);
      if (missing.length > 0) {
        throw new ConfigError(
          `[decisions.providers.${name}] is missing required key(s): ${missing.join(', ')}`,
          file,
          `decisions.providers.${name}`,
        );
      }
      const protocol = requireString(profileTable['protocol'], file, `decisions.providers.${name}.protocol`);
      if (protocol !== 'openrouter-decisions' && protocol !== 'systemone') {
        throw new ConfigError(
          `decisions.providers.${name}.protocol must be "openrouter-decisions" or "systemone"`,
          file,
          `decisions.providers.${name}.protocol`,
        );
      }
      const credential = requireString(profileTable['credential'], file, `decisions.providers.${name}.credential`);
      const profile: DecisionProviderTable = {
        protocol,
        endpoint: requireString(profileTable['endpoint'], file, `decisions.providers.${name}.endpoint`),
        model: requireString(profileTable['model'], file, `decisions.providers.${name}.model`),
        credential,
        timeoutMs: requirePositiveInt(profileTable['timeout_ms'], file, `decisions.providers.${name}.timeout_ms`),
        inputPricePerMtok:
          profileTable['input_price_per_mtok'] !== undefined
            ? requireNonNegativeNumber(profileTable['input_price_per_mtok'], file, `decisions.providers.${name}.input_price_per_mtok`)
            : DEFAULT_INPUT_PRICE_PER_MTOK,
      };
      try {
        validateProviderProfile(profile, `decisions.providers.${name}`);
      } catch (error) {
        throw new ConfigError(
          error instanceof Error ? error.message : String(error),
          file,
          `decisions.providers.${name}`,
        );
      }
      providers[name] = profile;
    }
  }
  // Per-surface routing and mode (issue #223). Both documented spellings
  // are accepted — the shorthand `surface = "profile"` (routing only,
  // legacy behavior preserved) and the explicit
  // `[decisions.surfaces.<surface>]` table with `provider` and/or `mode`.
  // Every named provider must exist in the effective set (built-ins + this
  // table); mode must be one of off|shadow|enforce when present.
  const surfaces: Record<string, DecisionSurfaceConfig> = Object.create(null);
  if (table['surfaces'] !== undefined) {
    const surfacesTable = requireTable(table['surfaces'], file, 'decisions.surfaces');
    const effective = effectiveDecisionProviders({ ...defaults, jev, providers, surfaces: {} });
    for (const surface of Object.keys(surfacesTable)) {
      if (!Object.prototype.hasOwnProperty.call(surfacesTable, surface)) continue;
      if (!/^[a-z0-9_]+$/u.test(surface)) {
        throw new ConfigError(
          `decision surface name \`${surface}\` must match [a-z0-9_]+`,
          file,
          `decisions.surfaces.${surface}`,
        );
      }
      let entry: DecisionSurfaceConfig;
      const raw = surfacesTable[surface];
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const surfaceTable = raw as Record<string, unknown>;
        for (const key of Object.keys(surfaceTable)) {
          if (key !== 'provider' && key !== 'mode') {
            throw new ConfigError(
              `unknown key \`${key}\` in [decisions.surfaces.${surface}] (valid keys: mode, provider)`,
              file,
              `decisions.surfaces.${surface}.${key}`,
            );
          }
        }
        if (surfaceTable['provider'] === undefined && surfaceTable['mode'] === undefined) {
          throw new ConfigError(
            `[decisions.surfaces.${surface}] is empty; name \`provider\` and/or \`mode\``,
            file,
            `decisions.surfaces.${surface}`,
          );
        }
        entry = {};
        if (surfaceTable['provider'] !== undefined) {
          entry = {
            ...entry,
            provider: requireString(surfaceTable['provider'], file, `decisions.surfaces.${surface}.provider`),
          };
        }
        if (surfaceTable['mode'] !== undefined) {
          const mode = requireString(surfaceTable['mode'], file, `decisions.surfaces.${surface}.mode`);
          if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
            throw new ConfigError(
              `decisions.surfaces.${surface}.mode must be one of: off, shadow, enforce`,
              file,
              `decisions.surfaces.${surface}.mode`,
            );
          }
          entry = { ...entry, mode };
        }
      } else {
        entry = { provider: requireString(raw, file, `decisions.surfaces.${surface}`) };
      }
      const profile = entry.provider;
      if (profile !== undefined && !Object.prototype.hasOwnProperty.call(effective, profile)) {
        throw new ConfigError(
          `decisions.surfaces.${surface} names unknown provider profile \`${profile}\` (available: ${Object.keys(effective).join(', ')})`,
          file,
          `decisions.surfaces.${surface}`,
        );
      }
      surfaces[surface] = entry;
    }
  }
  let thresholds = defaults.thresholds;
  if (table['thresholds'] !== undefined) {
    const thresholdsTable = requireTable(table['thresholds'], file, 'decisions.thresholds');
    const risks = ['read_only', 'operational', 'destructive'] as const;
    for (const key of Object.keys(thresholdsTable)) {
      if (!(risks as readonly string[]).includes(key)) {
        throw new ConfigError(
          `unknown key \`${key}\` in [decisions.thresholds] (valid keys: ${risks.join(', ')})`,
          file,
          `decisions.thresholds.${key}`,
        );
      }
    }
    thresholds = {
      read_only:
        thresholdsTable['read_only'] !== undefined
          ? readDecisionThreshold(thresholdsTable['read_only'], file, 'decisions.thresholds.read_only', thresholds.read_only)
          : thresholds.read_only,
      operational:
        thresholdsTable['operational'] !== undefined
          ? readDecisionThreshold(thresholdsTable['operational'], file, 'decisions.thresholds.operational', thresholds.operational)
          : thresholds.operational,
      destructive:
        thresholdsTable['destructive'] !== undefined
          ? readDecisionThreshold(thresholdsTable['destructive'], file, 'decisions.thresholds.destructive', thresholds.destructive)
          : thresholds.destructive,
    };
  }
  if (!thresholds.destructive.requireConfirmOnAct) {
    throw new ConfigError(
      'decisions.thresholds.destructive.require_confirm_on_act must be true',
      file,
      'decisions.thresholds.destructive.require_confirm_on_act',
    );
  }
  return { jev, providers, surfaces, thresholds };
}

/** Keys accepted per [runtimes.<id>]; the catalog-refresh knobs are pi-only. */
const RUNTIME_POLICY_KEYS: Readonly<Record<RuntimeId, readonly string[]>> = {
  pi: ['model', 'thinking_level', 'model_refresh', 'model_refresh_timeout_ms', 'roles'],
  'claude-code': ['model', 'thinking_level', 'mcp', 'roles'],
};

/**
 * Parse one [runtimes.<id>] policy table: optional model + thinking_level,
 * optional per-role inline tables { model?, thinking_level? } with at
 * least one field set (SPEC ruling 16). A pi-only knob under another
 * runtime is rejected loudly rather than parsed and ignored.
 */
function readRuntimePolicy(
  value: unknown,
  file: string,
  field: string,
  runtimeId: RuntimeId,
): RuntimeModelPolicy {
  const table = requireTable(value, file, field);
  const validKeys = RUNTIME_POLICY_KEYS[runtimeId];
  for (const key of Object.keys(table)) {
    if (!validKeys.includes(key)) {
      throw new ConfigError(
        `unknown key \`${key}\` in [${field}] (valid keys: ${validKeys.join(', ')})`,
        file,
        `${field}.${key}`,
      );
    }
  }
  let model: string | undefined;
  let thinkingLevel: string | undefined;
  let modelRefresh: boolean | undefined;
  let modelRefreshTimeoutMs: number | undefined;
  let mcp: ClaudeMcpMode | undefined;
  const roles: Partial<Record<Role, RuntimeRolePolicyEntry>> = {};
  if (table['model'] !== undefined) {
    model = requireString(table['model'], file, `${field}.model`);
  }
  if (table['thinking_level'] !== undefined) {
    thinkingLevel = requireString(table['thinking_level'], file, `${field}.thinking_level`);
  }
  if (runtimeId === 'pi' && table['model_refresh'] !== undefined) {
    modelRefresh = requireBool(table['model_refresh'], file, `${field}.model_refresh`);
  }
  if (runtimeId === 'pi' && table['model_refresh_timeout_ms'] !== undefined) {
    modelRefreshTimeoutMs = requirePositiveInt(
      table['model_refresh_timeout_ms'],
      file,
      `${field}.model_refresh_timeout_ms`,
    );
  }
  if (runtimeId === 'claude-code' && table['mcp'] !== undefined) {
    const value = requireString(table['mcp'], file, `${field}.mcp`);
    if (!(CLAUDE_MCP_MODES as readonly string[]).includes(value)) {
      throw new ConfigError(
        `${field}.mcp must be one of ${CLAUDE_MCP_MODES.map((mode) => `"${mode}"`).join(', ')}, got "${value}"`,
        file,
        `${field}.mcp`,
      );
    }
    mcp = value as ClaudeMcpMode;
  }
  if (table['roles'] !== undefined) {
    const rolesTable = requireTable(table['roles'], file, `${field}.roles`);
    for (const [roleKey, entry] of Object.entries(rolesTable)) {
      if (!(ROLES as readonly string[]).includes(roleKey)) {
        throw new ConfigError(
          `unknown role \`${roleKey}\` (valid roles: ${ROLES.join(', ')})`,
          file,
          `${field}.roles.${roleKey}`,
        );
      }
      const entryTable = requireTable(entry, file, `${field}.roles.${roleKey}`);
      let entryModel: string | undefined;
      let entryThinking: string | undefined;
      for (const entryKey of Object.keys(entryTable)) {
        if (!['model', 'thinking_level'].includes(entryKey)) {
          throw new ConfigError(
            `unknown key \`${entryKey}\` in [${field}.roles.${roleKey}] (valid keys: model, thinking_level)`,
            file,
            `${field}.roles.${roleKey}.${entryKey}`,
          );
        }
      }
      if (entryTable['model'] !== undefined) {
        entryModel = requireString(entryTable['model'], file, `${field}.roles.${roleKey}.model`);
      }
      if (entryTable['thinking_level'] !== undefined) {
        entryThinking = requireString(
          entryTable['thinking_level'],
          file,
          `${field}.roles.${roleKey}.thinking_level`,
        );
      }
      if (entryModel === undefined && entryThinking === undefined) {
        throw new ConfigError(
          `[${field}.roles.${roleKey}] must set at least one of model, thinking_level`,
          file,
          `${field}.roles.${roleKey}`,
        );
      }
      roles[roleKey as Role] = {
        ...(entryModel !== undefined ? { model: entryModel } : {}),
        ...(entryThinking !== undefined ? { thinkingLevel: entryThinking } : {}),
      };
    }
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(modelRefresh !== undefined ? { modelRefresh } : {}),
    ...(modelRefreshTimeoutMs !== undefined ? { modelRefreshTimeoutMs } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    roles,
  };
}
