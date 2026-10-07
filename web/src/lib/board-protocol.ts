/**
 * Board socket + API contract (client side, E6) — the mirror of the
 * service's src/board/frames.ts. Snapshots are idempotent and
 * last-write-wins: no replay/seq machinery, the server pushes a fresh
 * snapshot after auth and on every change; a reconnect starts over.
 */

export const BOARD_WS_PATH = '/board/ws';

export interface LensChipView {
  readonly lens: string;
  readonly state: string;
  readonly agentId: string | null;
  readonly note: string | null;
  /** Verdict parsed off the outcome note (`blocker — evidence`); null until one lands. */
  readonly verdict: string | null;
}

/** One lens's retry count inside a round. */
export interface LensAttemptView {
  readonly lens: string;
  readonly attempts: number;
}

export interface RoundView {
  readonly id: string;
  readonly seq: number;
  readonly status: string;
  readonly verdict: string | null;
  readonly targetRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lenses: readonly LensChipView[];
  readonly lensAttempts: readonly LensAttemptView[];
  readonly blockers: number;
}

/** The job's managed worktree lane (branch, base sha, age). */
export interface LaneView {
  readonly branch: string | null;
  readonly sha: string;
  readonly status: string;
  readonly createdAt: string;
}

/** PR state the board buckets and counts on (board UX v4). `open` and
 * `merged` derive from the record today; `conflicting` is the
 * cascade-promoter signal the PR-state sweep will write — the board
 * consumes it the day it appears and never invents it. */
export type JobPrState = 'open' | 'conflicting' | 'merged';

export interface JobView {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  /** Absent on older servers; null for jobs without an authored name. */
  readonly displayName?: string | null;
  readonly status: string;
  readonly updatedAt: string;
  readonly prUrl: string | null;
  readonly prState: JobPrState | null;
  readonly baseBranch: string | null;
  readonly note: string | null;
  readonly rounds: readonly RoundView[];
  readonly lane: LaneView | null;
  readonly lastAgentActivity: string | null;
}

/** Issue #161: one tracked child worker (sub-minion). */
export interface ChildWorkerView {
  readonly id: string;
  readonly agentId: string | null;
  readonly parentAgentId: string;
  readonly jobId: string;
  readonly purpose: string;
  readonly authority: 'read-only' | 'writer';
  readonly state: 'queued' | 'admitted' | 'active' | 'done' | 'error' | 'cancelled';
  readonly worktreeId: string | null;
  readonly branch: string | null;
  readonly resultState: 'done' | 'error' | 'cancelled' | null;
  readonly resultSummary: string | null;
  readonly resultRef: string | null;
  readonly createdAt: string;
  readonly admittedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** Issue #161: child counters. Present-state counts are derived from the
 * durable records; `lifetimeCreations` counts LOGICAL creations (one per
 * admitted child request), so retries and resumes never double-count. */
export interface ChildWorkerCounts {
  readonly queued: number;
  readonly active: number;
  readonly finished: number;
  readonly lifetimeCreations: number;
}

export interface AgentView {
  readonly id: string;
  readonly role: string;
  readonly label: string | null;
  readonly state: string;
  /** Issue #161 parentage category. Optional: pre-upgrade servers omit it
   * and the board renders no top-level/child distinction (`undefined` =
   * no information; `null` = the server says genuinely unknown). */
  readonly parentage?: 'top-level' | 'child' | null;
  /** Issue #161 parent link for child rows (parent navigation). */
  readonly parentAgentId?: string | null;
  /** The child record when this row IS a tracked child. */
  readonly child?: ChildWorkerView | null;
  /** Family counters on a parent row with admitted children. */
  readonly childCounts?: ChildWorkerCounts | null;
  /** Issue #171 truthful display status: the raw adapter state corrected
   * by supervision activity evidence (raw `idle` + open turn →
   * `streaming`). Optional: pre-upgrade servers omit it and the board
   * falls back to the raw `state`. */
  readonly status?: string;
  /** Issue #171 runtime ownership classification. Optional: pre-upgrade
   * servers omit it and the board treats membership as `unverified`
   * (visible, explicitly ambiguous — never guessed historical). */
  readonly runtime?: 'current' | 'historical' | 'unverified';
  readonly lastActivity: string | null;
  /** Row registration stamp. Optional: pre-upgrade servers did not send
   * it, and the board then falls back to lastActivity-only stall truth. */
  readonly createdAt?: string;
  readonly sessionFile: string | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
  /** E7 supervision view (null when unsupervised). `stopReason` is absent
   * on pre-reason servers — the board renders the stop without a cause;
   * `stoppedAt` is absent on pre-stop-time servers and null/ignored while
   * running. Issue #171 activity fields (`openTurn`, `openControl`,
   * `openToolCalls`, `lastEventAt`) are optional on pre-#171 servers. */
  readonly supervision: {
    readonly state: 'watching' | 'restarting' | 'stopped';
    readonly restarts: number;
    readonly breakerOpen: boolean;
    readonly stopReason?: string | null;
    readonly stoppedAt?: string | null;
    readonly openTurn?: boolean;
    readonly openControl?: boolean;
    readonly openToolCalls?: number;
    readonly lastEventAt?: string | null;
  } | null;
}

export interface NotificationView {
  readonly id: string;
  readonly ts: string;
  readonly kind: string;
  readonly routing: 'fyi' | 'action-required' | 'needs-owner';
  readonly severity: 'info' | 'error';
  readonly title: string;
  readonly detail: string | null;
  readonly agentId: string | null;
  readonly shownAt: string | null;
  readonly ackedAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

export interface DecisionStatusView {
  readonly enabled: boolean;
  readonly status: 'disabled' | 'checking' | 'ready' | 'degraded';
  readonly reason: string | null;
  readonly model: string;
  readonly endpoint: string;
  readonly credentialPresent: boolean;
  readonly credentialSource: 'environment' | 'file' | 'none';
  readonly checkedAt: string | null;
  readonly incarnation: string;
  readonly generation: number;
}

/** Deploy drift (board UX v4): the running service build vs origin/main.
 * Computed service-side (git) and shipped on the live snapshot; null
 * blocks render an honest unknown, never a guessed count. */
export interface BuildView {
  /** Git rev the running service was built from. */
  readonly buildRev: string | null;
  readonly buildCommittedAt: string | null;
  readonly originMainRev: string | null;
  readonly originMainCommittedAt: string | null;
  /** origin/main commits not reachable from the build. */
  readonly commitsBehind: number | null;
  readonly checkedAt: string | null;
  /** Why the last check could not fully prove the count (null = clean). */
  readonly checkError: string | null;
}

/** Silas ops health (board UX v4, issue #163), derived from the durable
 * event stream. `lastWakeAt` is the wake START marker; `lastReconcileAt`
 * only advances on a successfully completed deterministic pass. */
export interface SilasView {
  readonly lastWakeAt: string | null;
  readonly lastTickAt: string | null;
  readonly lastReconcileAt: string | null;
  readonly lastReconcileFailedAt: string | null;
  readonly reconcileFailedNewer: boolean;
  readonly lastUsefulActionAt: string | null;
  readonly nextAction: string | null;
  readonly openTurnSince: string | null;
  readonly reconciliationsToday: number;
  readonly checkedAt: string;
}

/** Verification scheduler queue (board UX v4, from the #52 scheduler). */
export interface VerifyQueueView {
  readonly lockInUse: boolean;
  readonly activeRuns: number;
  readonly queuedRuns: number;
  readonly workerBudget: number;
  readonly workersPerRun: number;
}

/** Provider pacing gate (server mirror; board protocol parity). A capped
 * pool's honest state: the configured limit, how many turns run, and every
 * queued entry with its queue time and reason. */
export interface PacingQueueEntryView {
  readonly id: string;
  readonly kind: 'worker' | 'review';
  readonly label: string;
  readonly queuedAt: string;
  readonly reason: string;
}

export interface PacingPoolView {
  /** Configured limit; 0 = unlimited. */
  readonly limit: number;
  readonly running: number;
  readonly queued: readonly PacingQueueEntryView[];
}

export interface PacingGateView {
  readonly enabled: boolean;
  readonly worker: PacingPoolView;
  readonly review: PacingPoolView;
}

/** Self-healing session stats (board UX v4; null until a producer exists). */
export interface SelfHealView {
  readonly sessionsResumed: number;
  readonly sessionsOrphaned: number;
  readonly since: string | null;
}

/** Decision memory (issue #218): one active hold/disposition — the state
 * behind a suppressed signal, visible instead of prose-only. A UI panel
 * can follow later; the payload carries the truth today. */
export interface ActiveDecisionView {
  readonly id: string;
  readonly subject: string;
  readonly decision: string;
  readonly by: string;
  readonly recheckAt: string | null;
  readonly createdAt: string;
}

/** FOR YOU (owner approval 2026-09-28): one PR genuinely ready for the
 * owner — the SERVER-computed, evidence-bound projection (approved
 * head-bound review round + clean mergeable state + green CI at the
 * exact head). The browser never re-derives readiness. */
export interface OwnerPrView {
  /** Stable row/action id: `owner-pr:{jobId}`. */
  readonly id: string;
  readonly jobId: string;
  readonly jobTitle: string;
  readonly repo: string;
  /** https PR URL — the OPEN PR target, never an in-app merge. */
  readonly prUrl: string;
  /** The exact head sha every piece of evidence is bound to. */
  readonly sha: string;
  /** ISO stamp of the branch-state observation the row rests on. */
  readonly checkedAt: string;
}

/** Durable pipeline queue (owner approvals j-239/j-1064): one active
 * entry as the SERVER evaluated it — waiting/ready/admitting/failed
 * with the exact wait reason. Admitted/cancelled entries are excluded
 * server-side (admitted work lives in the normal job lifecycle). The
 * browser never re-derives eligibility. */
export interface PipelineEntryView {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly priority: number;
  readonly enqueueSeq: number;
  readonly state: 'waiting' | 'ready' | 'admitting' | 'failed';
  readonly reason: string | null;
  readonly queuedAt: string;
}

export interface PipelineView {
  readonly entries: readonly PipelineEntryView[];
  /** All active entries — full count, never the preview window. */
  readonly pending: number;
}

/** Managed repository overview (owner-approved compact rows A): one
 * row per configured managed repository. Server-computed and additive —
 * absent/null on pre-upgrade servers and until the tracker's first
 * refresh pass, in which case the board hides the section entirely.
 * Counts are repo-wide exact totals (issues excluding PRs); the run is
 * the newest Actions run on the repository's discovered default branch,
 * never deployment health. */
export const REPO_OVERVIEW_RUN_STATES = [
  'passed',
  'failed',
  'timed-out',
  'startup-failure',
  'action-required',
  'cancelled',
  'skipped',
  'neutral',
  'stale-run',
  'running',
  'queued',
  'no-workflow',
  'never-run',
  'no-branch',
  'unavailable',
  'unknown',
] as const;

export type RepoOverviewRunState = (typeof REPO_OVERVIEW_RUN_STATES)[number];

export const REPO_OVERVIEW_FRESHNESS = ['unchecked', 'fresh', 'stale', 'unavailable'] as const;

export type RepoOverviewFreshness = (typeof REPO_OVERVIEW_FRESHNESS)[number];

/** One observed run. `status`/`conclusion` are raw provider strings
 * (untrusted display text); `url` is https on the repository host only. */
export interface RepoOverviewRunView {
  readonly state: RepoOverviewRunState;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly workflow: string | null;
  readonly branch: string | null;
  readonly runNumber: number | null;
  readonly url: string | null;
  readonly runStartedAt: string | null;
  readonly runUpdatedAt: string | null;
}

export interface RepoOverviewRowView {
  /** Stable registry identity (repository directory name). */
  readonly key: string;
  readonly displayName: string;
  readonly linked: boolean;
  /** The GitHub host the identity was read from (null when not linked). */
  readonly host: string | null;
  readonly link: string | null;
  readonly linkReason: string | null;
  readonly fullName: string | null;
  /** Exact repo-wide open pull-request count (null = not proven). */
  readonly openPrs: number | null;
  /** Exact open-issue count EXCLUDING pull requests (null = not proven). */
  readonly openIssues: number | null;
  readonly run: RepoOverviewRunView | null;
  readonly freshness: RepoOverviewFreshness;
  /** Last successful complete observation (ISO); null = none yet. */
  readonly checkedAt: string | null;
  /** Last observation attempt (ISO); null = never attempted. */
  readonly lastAttemptAt: string | null;
  /** Last failed attempt detail; null = clean. */
  readonly error: string | null;
}

export interface RepoOverviewView {
  readonly rows: readonly RepoOverviewRowView[];
}

export interface BoardSnapshot {
  readonly repos: readonly { readonly name: string; readonly jobs: readonly JobView[] }[];
  readonly agents: readonly AgentView[];
  readonly notifications: readonly NotificationView[];
  readonly decisions: DecisionStatusView;
  /** NEEDS GRU: LIVE machine-attention rows awaiting a disposition
   * (terminal-bound rows are closed receipts and are not counted here). */
  readonly unackedActionRequired: number;
  /** FOR YOU: needs-owner rows awaiting a human ack (the bell class). */
  readonly unackedNeedsOwner: number;
  /** Autonomous Gru wakes fired by the policy (`gru.wake` events). */
  readonly wakes: {
    readonly count: number;
    readonly lastAt: string | null;
    /** Issue #219: avoidance counts with reasons; absent on pre-upgrade
     * servers (validator tolerates). `truncated` = the server tally hit
     * its scan cap (counts are a lower bound). */
    readonly deferred?: {
      readonly count: number;
      readonly reasons: Readonly<Record<string, number>>;
      readonly truncated?: boolean;
    } | null;
  };
  /** Absent on pre-v4 servers (validator tolerates; consumers render n/a). */
  readonly build?: BuildView | null;
  readonly silas?: SilasView | null;
  readonly verify?: VerifyQueueView | null;
  /** Provider pacing gate (server mirror; absent on pre-pacing servers). */
  readonly pacing?: PacingGateView | null;
  /** Durable pipeline queue; absent on pre-upgrade servers (tolerated). */
  readonly pipeline?: PipelineView | null;
  readonly selfHeal?: SelfHealView | null;
  /** Decision memory (issue #218): active holds/dispositions; absent on
  * pre-upgrade servers (validator tolerates). */
  readonly activeDecisions?: readonly ActiveDecisionView[] | null;
  /** Truthful total of active decisions — the snapshot's activeDecisions
  * is a bounded newest-first window, so the count exposes overflow. */
  readonly activeDecisionCount?: number | null;
  /** FOR YOU PR rows (owner approval 2026-09-28); absent on pre-upgrade
  * servers (validator tolerates; the band renders ack rows only). */
  readonly ownerPrs?: readonly OwnerPrView[] | null;
  /** Managed repository overview (owner-approved compact rows A); absent
  * on pre-upgrade servers and null until the tracker's first refresh
  * pass (the board then hides the section rather than claiming an empty
  * registry). A present block is validated strictly below. */
  readonly repoOverview?: RepoOverviewView | null;
  /** Issue #161: tracker-wide child counters; absent on pre-upgrade
  * servers (the strip then renders no child numbers). */
  readonly children?: ChildWorkerCounts | null;
}

export interface TranscriptInfo {
  readonly file: string;
  readonly role: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly agentId: string | null;
  readonly agentLabel: string | null;
}

export interface TranscriptEntry {
  readonly index: number;
  readonly ts: number | null;
  readonly kind: 'user' | 'assistant' | 'tool_result' | 'system' | 'other';
  readonly role: string | null;
  readonly text: string;
  readonly thinking: string | null;
  readonly toolName: string | null;
  readonly isError: boolean;
}

export interface TranscriptPage {
  readonly file: string;
  readonly total: number;
  readonly entries: readonly TranscriptEntry[];
  readonly nextCursor: number | null;
  readonly skippedTornLines: number;
}

export interface TranscriptMatch {
  readonly index: number;
  readonly kind: TranscriptEntry['kind'];
  readonly snippet: string;
}

export interface TranscriptSearchResult {
  readonly file: string;
  readonly query: string;
  readonly matches: readonly TranscriptMatch[];
  readonly scanned: number;
  /** Total entries in the file — scanned < total discloses truncation. */
  readonly total: number;
}

export interface BoardAuthOkFrame {
  readonly type: 'auth_ok';
}

/** Application-level keepalive: the server proves liveness while the board
 * is otherwise quiet; the client refreshes its stale clock on ANY frame.
 * No sequence or snapshot semantics — a dropped ping is simply retried by
 * the next one. */
export interface BoardPingFrame {
  readonly type: 'ping';
}

export interface BoardSnapshotFrame {
  readonly type: 'board';
  readonly snapshot: BoardSnapshot;
}

export interface BoardErrorFrame {
  readonly type: 'error';
  readonly message: string;
  readonly fatal: boolean;
}

export type BoardServerFrame = BoardAuthOkFrame | BoardPingFrame | BoardSnapshotFrame | BoardErrorFrame;

/** Parse + validate one inbound server frame; null when malformed. */
export function parseBoardServerFrame(raw: unknown): BoardServerFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  if (frame.type === 'auth_ok') return { type: 'auth_ok' };
  if (frame.type === 'ping') return { type: 'ping' };
  if (frame.type === 'error' && typeof frame.message === 'string' && typeof frame.fatal === 'boolean') {
    return { type: 'error', message: frame.message, fatal: frame.fatal };
  }
  if (frame.type === 'board' && isValidSnapshot(frame.snapshot)) {
    return { type: 'board', snapshot: frame.snapshot as BoardSnapshot };
  }
  return null;
}

/** True when the value carries at least one visible character: zero-width
 * and format controls (Unicode Cf), controls (Cc), and combining marks
 * (M) do not count — mirror of the ledger's visibility rule, so a
 * server that somehow persisted an invisible-only name is rejected here
 * instead of rendering an empty card. (The ledger's 100-code-unit length
 * ceiling is not mirrored; the rail shortens for display anyway.) */
function hasVisibleCharacters(value: string): boolean {
  return value.replace(/[\p{Cf}\p{Cc}\p{M}\s]/gu, '') !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const SUPERVISION_STATES = ['watching', 'restarting', 'stopped'] as const;

/** Issue #171 runtime membership classes: an unknown value is a server
 * bug, never a silently tolerated value. */
const RUNTIME_CLASSES = ['current', 'historical', 'unverified'] as const;

/** Issue #161: honest parentage categories (null = genuinely unknown). */
const PARENTAGES = ['top-level', 'child'] as const;

function isParentage(value: unknown): value is (typeof PARENTAGES)[number] {
  return typeof value === 'string' && (PARENTAGES as readonly string[]).includes(value);
}

/** Issue #161: a present child counter block is typed strictly — a
 * malformed count must never render as a number the server did not
 * prove. */
function isChildCounts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (['queued', 'active', 'finished', 'lifetimeCreations'] as const).every(
    (key) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0,
  );
}

/** Issue #161: a present child view must at least carry a real identity
 * and lifecycle state; the rest of the projection is renderable. */
function isChildView(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.parentAgentId === 'string' &&
    typeof value.jobId === 'string' &&
    typeof value.purpose === 'string' &&
    (value.authority === 'read-only' || value.authority === 'writer') &&
    (['queued', 'admitted', 'active', 'done', 'error', 'cancelled'] as readonly unknown[]).includes(value.state)
  );
}

function isRuntimeClass(value: unknown): value is (typeof RUNTIME_CLASSES)[number] {
  return typeof value === 'string' && (RUNTIME_CLASSES as readonly string[]).includes(value);
}

/** Issue #171: the known agent display states. An unknown `status` is a
 * server bug, never a silently tolerated value (mirrors the supervision
 * state validation rule). */
const AGENT_STATE_NAMES = ['spawning', 'idle', 'streaming', 'error', 'disposed'] as const;

function isAgentStateName(value: unknown): value is (typeof AGENT_STATE_NAMES)[number] {
  return typeof value === 'string' && (AGENT_STATE_NAMES as readonly string[]).includes(value);
}

/** The E7 supervision block's known states: an unknown state is a server
 * bug, never a silently tolerated value. */
function isSupervisionState(value: unknown): value is (typeof SUPERVISION_STATES)[number] {
  return typeof value === 'string' && (SUPERVISION_STATES as readonly string[]).includes(value);
}

/** A restart count must be a finite non-negative number. A malformed value
 * must not reach the chip/stop predicate as a false-live read (tracked-
 * review A9). */
function isRestartCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Parse one OUTBOUND client frame (the auth frame clients send); null on
 * anything malformed. Lives here so server and web share the same rules
 * (parity-tested in test/board-frames.test.ts). */
export function parseBoardClientFrame(raw: unknown): { type: 'auth'; token: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  // Shape-level only: an empty-string token PARSES here and fails token
  // MATCHING on the server.
  if (frame.type !== 'auth' || typeof frame.token !== 'string') return null;
  return { type: 'auth', token: frame.token };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nstr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function isValidDecisionStatus(value: unknown): value is DecisionStatusView {
  return isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    typeof value.status === 'string' &&
    ['disabled', 'checking', 'ready', 'degraded'].includes(value.status) &&
    (value.reason === null || typeof value.reason === 'string') &&
    typeof value.model === 'string' &&
    typeof value.endpoint === 'string' &&
    typeof value.credentialPresent === 'boolean' &&
    typeof value.credentialSource === 'string' &&
    ['none', 'environment', 'file'].includes(value.credentialSource) &&
    (value.checkedAt === null || typeof value.checkedAt === 'string') &&
    typeof value.incarnation === 'string' && value.incarnation.length > 0 &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) >= 0;
}

function isLensAttempt(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.lens === 'string' &&
    typeof value.attempts === 'number' &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts >= 0
  );
}

function isLane(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.branch === null || typeof value.branch === 'string') &&
    typeof value.sha === 'string' &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function isPrState(value: unknown): value is JobPrState {
  return value === 'open' || value === 'conflicting' || value === 'merged';
}

/** Tolerant null checks for the v4 optional blocks: absent/null passes
 * (pre-v4 servers), a present block must match its full shape. */
function isBuildView(value: unknown): value is BuildView {
  return (
    isRecord(value) &&
    (value.buildRev === null || typeof value.buildRev === 'string') &&
    (value.buildCommittedAt === null || typeof value.buildCommittedAt === 'string') &&
    (value.originMainRev === null || typeof value.originMainRev === 'string') &&
    (value.originMainCommittedAt === null || typeof value.originMainCommittedAt === 'string') &&
    (value.commitsBehind === null ||
      (typeof value.commitsBehind === 'number' && Number.isSafeInteger(value.commitsBehind) && value.commitsBehind >= 0)) &&
    (value.checkedAt === null || typeof value.checkedAt === 'string') &&
    (value.checkError === null || typeof value.checkError === 'string')
  );
}

function isSilasView(value: unknown): value is SilasView {
  return (
    isRecord(value) &&
    (value.lastWakeAt === null || typeof value.lastWakeAt === 'string') &&
    (value.lastTickAt === null || typeof value.lastTickAt === 'string') &&
    (value.lastReconcileAt === null || typeof value.lastReconcileAt === 'string') &&
    (value.lastReconcileFailedAt === null || typeof value.lastReconcileFailedAt === 'string') &&
    typeof value.reconcileFailedNewer === 'boolean' &&
    (value.lastUsefulActionAt === null || typeof value.lastUsefulActionAt === 'string') &&
    (value.nextAction === null || typeof value.nextAction === 'string') &&
    (value.openTurnSince === null || typeof value.openTurnSince === 'string') &&
    typeof value.reconciliationsToday === 'number' &&
    Number.isSafeInteger(value.reconciliationsToday) &&
    value.reconciliationsToday >= 0 &&
    typeof value.checkedAt === 'string'
  );
}

function isVerifyQueueView(value: unknown): value is VerifyQueueView {
  return (
    isRecord(value) &&
    typeof value.lockInUse === 'boolean' &&
    (typeof value.activeRuns === 'number' && Number.isSafeInteger(value.activeRuns) && value.activeRuns >= 0) &&
    (typeof value.queuedRuns === 'number' && Number.isSafeInteger(value.queuedRuns) && value.queuedRuns >= 0) &&
    (typeof value.workerBudget === 'number' && Number.isSafeInteger(value.workerBudget) && value.workerBudget >= 0) &&
    (typeof value.workersPerRun === 'number' && Number.isSafeInteger(value.workersPerRun) && value.workersPerRun >= 0)
  );
}

function isPacingQueueEntryView(value: unknown): value is PacingQueueEntryView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'worker' || value.kind === 'review') &&
    typeof value.label === 'string' &&
    typeof value.queuedAt === 'string' &&
    typeof value.reason === 'string'
  );
}

function isPacingPoolView(value: unknown): value is PacingPoolView {
  return (
    isRecord(value) &&
    (typeof value.limit === 'number' && Number.isSafeInteger(value.limit) && value.limit >= 0) &&
    (typeof value.running === 'number' && Number.isSafeInteger(value.running) && value.running >= 0) &&
    Array.isArray(value.queued) &&
    value.queued.every(isPacingQueueEntryView)
  );
}

function isPacingGateView(value: unknown): value is PacingGateView {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isPacingPoolView(value.worker) &&
    isPacingPoolView(value.review)
  );
}

function isSelfHealView(value: unknown): value is SelfHealView {
  return (
    isRecord(value) &&
    (typeof value.sessionsResumed === 'number' && Number.isSafeInteger(value.sessionsResumed) && value.sessionsResumed >= 0) &&
    (typeof value.sessionsOrphaned === 'number' && Number.isSafeInteger(value.sessionsOrphaned) && value.sessionsOrphaned >= 0) &&
    (value.since === null || typeof value.since === 'string')
  );
}

function isActiveDecisionView(value: unknown): value is ActiveDecisionView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' && value.id !== '' &&
    typeof value.subject === 'string' && value.subject !== '' &&
    typeof value.decision === 'string' && value.decision !== '' &&
    typeof value.by === 'string' && value.by !== '' &&
    (value.recheckAt === null || typeof value.recheckAt === 'string') &&
    typeof value.createdAt === 'string' && value.createdAt !== ''
  );
}

function isPipelineEntryView(value: unknown): value is PipelineEntryView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' && value.id !== '' &&
    typeof value.repo === 'string' &&
    typeof value.title === 'string' &&
    typeof value.priority === 'number' && Number.isSafeInteger(value.priority) && value.priority >= 0 &&
    typeof value.enqueueSeq === 'number' && Number.isSafeInteger(value.enqueueSeq) && value.enqueueSeq >= 1 &&
    (value.state === 'waiting' || value.state === 'ready' || value.state === 'admitting' || value.state === 'failed') &&
    (value.reason === null || typeof value.reason === 'string') &&
    typeof value.queuedAt === 'string'
  );
}

function isPipelineView(value: unknown): value is PipelineView {
  return (
    isRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(isPipelineEntryView) &&
    typeof value.pending === 'number' && Number.isSafeInteger(value.pending) && value.pending >= 0
  );
}

function isOwnerPrView(value: unknown): value is OwnerPrView {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' || value.id === '' ||
    typeof value.jobId !== 'string' || value.jobId === '' ||
    typeof value.jobTitle !== 'string' ||
    typeof value.repo !== 'string' ||
    typeof value.prUrl !== 'string' ||
    typeof value.sha !== 'string' || value.sha === '' ||
    typeof value.checkedAt !== 'string'
  ) {
    return false;
  }
  // OPEN PR targets are https only — a non-https prUrl can never render a
  // link, so it fails closed at the validator, the projection, AND the
  // render (three guards, one rule).
  try {
    return new URL(value.prUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Managed repository overview: known run states and freshness classes —
 * an unknown string is a server bug, never a silently tolerated value. */
function isRepoOverviewRunState(value: unknown): value is RepoOverviewRunState {
  return typeof value === 'string' && (REPO_OVERVIEW_RUN_STATES as readonly string[]).includes(value);
}

function isRepoOverviewFreshness(value: unknown): value is RepoOverviewFreshness {
  return typeof value === 'string' && (REPO_OVERVIEW_FRESHNESS as readonly string[]).includes(value);
}

function isNullableIso(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function isSafeCountOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

/** hrefs are https-or-nothing (the same fail-closed rule as ownerPrs). */
function isHttpsUrlOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isNonEmptyOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value !== '');
}

function isRepoOverviewRunView(value: unknown): value is RepoOverviewRunView {
  return (
    isRecord(value) &&
    isRepoOverviewRunState(value.state) &&
    isNonEmptyOrNull(value.status) &&
    isNonEmptyOrNull(value.conclusion) &&
    isNonEmptyOrNull(value.workflow) &&
    isNonEmptyOrNull(value.branch) &&
    (value.runNumber === null ||
      (typeof value.runNumber === 'number' && Number.isSafeInteger(value.runNumber) && value.runNumber >= 0)) &&
    isHttpsUrlOrNull(value.url) &&
    isNullableIso(value.runStartedAt) &&
    isNullableIso(value.runUpdatedAt)
  );
}

function isSafeHost(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && /^[A-Za-z0-9.-]+$/u.test(value);
}

function isRepoOverviewRowView(value: unknown): value is RepoOverviewRowView {
  if (
    !isRecord(value) ||
    typeof value.key !== 'string' ||
    value.key === '' ||
    typeof value.displayName !== 'string' ||
    !hasVisibleCharacters(value.displayName) ||
    typeof value.linked !== 'boolean' ||
    !(value.host === null || isSafeHost(value.host)) ||
    !isHttpsUrlOrNull(value.link) ||
    (value.linkReason !== null && typeof value.linkReason !== 'string') ||
    (value.fullName !== null && typeof value.fullName !== 'string') ||
    !isSafeCountOrNull(value.openPrs) ||
    !isSafeCountOrNull(value.openIssues) ||
    (value.run !== null && !isRepoOverviewRunView(value.run)) ||
    !isRepoOverviewFreshness(value.freshness) ||
    !isNullableIso(value.checkedAt) ||
    !isNullableIso(value.lastAttemptAt) ||
    (value.error !== null && typeof value.error !== 'string')
  ) {
    return false;
  }
  // Empty strings on the disclosure fields would render dangling
  // punctuation; the server normalizes them to null.
  if (typeof value.linkReason === 'string' && value.linkReason === '') return false;
  if (typeof value.error === 'string' && value.error === '') return false;
  // Freshness coherence mirrors the server's one-atomic-observation rule:
  // fresh/stale REQUIRE a successful observation (checkedAt, a run and
  // exact counts, and a clean error for fresh); the pre-success classes
  // never carry observed data, and unavailable MUST name its failure.
  const observed = value.freshness === 'fresh' || value.freshness === 'stale';
  if (observed && value.checkedAt === null) return false;
  if (observed && (value.openPrs === null || value.openIssues === null)) return false;
  if (observed && value.run === null) return false;
  if (value.freshness === 'fresh' && value.error !== null) return false;
  if (value.freshness === 'unchecked') {
    if (value.checkedAt !== null || value.lastAttemptAt !== null) return false;
    if (value.openPrs !== null || value.openIssues !== null || value.run !== null || value.error !== null) return false;
  }
  if (value.freshness === 'unavailable') {
    if (value.checkedAt !== null) return false;
    if (value.openPrs !== null || value.openIssues !== null || value.run !== null) return false;
    if (value.error === null) return false;
  }
  // Coherence: a linked row has a link and no reason; an unlinked row has
  // a reason and no link. A linked row must also carry a safe full name
  // that the link path actually addresses — a row can never validate as a
  // guessed or mismatched identity.
  if (!value.linked) {
    return (
      value.link === null &&
      value.linkReason !== null &&
      value.host === null &&
      value.openPrs === null &&
      value.openIssues === null &&
      value.run === null
    );
  }
  if (value.link === null || value.linkReason !== null || value.host === null) return false;
  if (typeof value.fullName !== 'string' || value.fullName === '') return false;
  const segments = value.fullName.split('/');
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/u.test(segment),
    )
  ) {
    return false;
  }
  try {
    const link = new URL(value.link);
    if (link.pathname !== `/${value.fullName}`) return false;
    // The link and any run link must live on the host the identity was
    // read from — an off-host URL can never present as this repository.
    if (link.hostname.toLowerCase() !== value.host.toLowerCase()) return false;
    if (value.run !== null && value.run.url !== null) {
      if (new URL(value.run.url).hostname.toLowerCase() !== value.host.toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isRepoOverviewView(value: unknown): value is RepoOverviewView {
  return isRecord(value) && Array.isArray(value.rows) && value.rows.every(isRepoOverviewRowView);
}

function isWakesView(value: unknown): boolean {
  if (
    !(
      isRecord(value) &&
      typeof value.count === 'number' &&
      Number.isSafeInteger(value.count) &&
      value.count >= 0 &&
      (value.lastAt === null || typeof value.lastAt === 'string')
    )
  ) {
    return false;
  }
  // Issue #219 deferred block: optional (pre-upgrade servers) but strictly
  // typed when present.
  if (value.deferred !== undefined && value.deferred !== null) {
    const deferred = value.deferred;
    if (!isRecord(deferred)) return false;
    if (typeof deferred.count !== 'number' || !Number.isSafeInteger(deferred.count) || deferred.count < 0) return false;
    if (!isRecord(deferred.reasons)) return false;
    for (const count of Object.values(deferred.reasons)) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return false;
    }
    if (deferred.truncated !== undefined && typeof deferred.truncated !== 'boolean') return false;
  }
  return true;
}

export function isValidSnapshot(value: unknown): value is BoardSnapshot {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.repos) || !Array.isArray(value.agents) || !Array.isArray(value.notifications)) {
    return false;
  }
  if (!isValidDecisionStatus(value.decisions)) return false;
  if (
    typeof value.unackedActionRequired !== 'number' ||
    !Number.isSafeInteger(value.unackedActionRequired) ||
    value.unackedActionRequired < 0 ||
    typeof value.unackedNeedsOwner !== 'number' ||
    !Number.isSafeInteger(value.unackedNeedsOwner) ||
    value.unackedNeedsOwner < 0 ||
    !isWakesView(value.wakes)
  ) {
    return false;
  }
  // v4 blocks are absent on pre-v4 servers (tolerated) but a present
  // block must match its shape — a malformed health read is a server bug.
  if (value.build !== undefined && value.build !== null && !isBuildView(value.build)) return false;
  if (value.silas !== undefined && value.silas !== null && !isSilasView(value.silas)) return false;
  if (value.verify !== undefined && value.verify !== null && !isVerifyQueueView(value.verify)) return false;
  if (value.pacing !== undefined && value.pacing !== null && !isPacingGateView(value.pacing)) return false;
  if (value.pipeline !== undefined && value.pipeline !== null && !isPipelineView(value.pipeline)) return false;
  if (value.selfHeal !== undefined && value.selfHeal !== null && !isSelfHealView(value.selfHeal)) return false;
  // Decision memory (issue #218): optional (pre-upgrade servers) but
  // strictly typed when present.
  if (value.activeDecisions !== undefined && value.activeDecisions !== null && !Array.isArray(value.activeDecisions)) return false;
  if (Array.isArray(value.activeDecisions) && !value.activeDecisions.every(isActiveDecisionView)) return false;
  if (value.activeDecisionCount !== undefined && value.activeDecisionCount !== null &&
    (typeof value.activeDecisionCount !== 'number' || !Number.isInteger(value.activeDecisionCount) || value.activeDecisionCount < 0)) return false;
  // FOR YOU PR rows: absent on pre-upgrade servers (tolerated), but a
  // present block must match its shape — readiness is server authority.
  if (value.ownerPrs !== undefined && value.ownerPrs !== null && !Array.isArray(value.ownerPrs)) return false;
  if (Array.isArray(value.ownerPrs) && !value.ownerPrs.every(isOwnerPrView)) return false;
  // Managed repository overview: optional (pre-upgrade/not-yet-refreshed)
  // but strictly typed when present — a malformed row must never render a
  // guessed identity, count or link.
  if (value.repoOverview !== undefined && value.repoOverview !== null && !isRepoOverviewView(value.repoOverview)) {
    return false;
  }
  // Issue #161: the tracker-wide child counters are optional (pre-upgrade
  // servers) but strictly typed when present.
  if (value.children !== undefined && value.children !== null && !isChildCounts(value.children)) return false;
  const agentsOk = value.agents.every(
    (agent) =>
      isRecord(agent) &&
      typeof agent.id === 'string' &&
      typeof agent.role === 'string' &&
      typeof agent.state === 'string' &&
      // Issue #171 fields are optional (pre-upgrade servers); present,
      // they are typed strictly — a junk runtime class or an unknown
      // status string must never reach the rail split as a false read.
      (agent.status === undefined || isAgentStateName(agent.status)) &&
      (agent.runtime === undefined || agent.runtime === null || isRuntimeClass(agent.runtime)) &&
      // Issue #161 child fields are optional (pre-upgrade servers); when a
      // server does send them, the parentage marker and counters are typed.
      (agent.parentage === undefined || agent.parentage === null || isParentage(agent.parentage)) &&
      (agent.parentAgentId === undefined ||
        agent.parentAgentId === null ||
        typeof agent.parentAgentId === 'string') &&
      (agent.child === undefined || agent.child === null || isChildView(agent.child)) &&
      (agent.childCounts === undefined ||
        agent.childCounts === null ||
        isChildCounts(agent.childCounts)) &&
      // createdAt is optional (pre-upgrade servers); present, it must be
      // a parseable date — the stall floor reads it directly and a junk
      // string would silently remove the floor (code review 2026-10-04).
      (agent.createdAt === undefined ||
        agent.createdAt === null ||
        (typeof agent.createdAt === 'string' && Number.isFinite(Date.parse(agent.createdAt)))) &&
      // supervision is optional (null when the agent is unsupervised);
      // stopReason is optional too (pre-reason servers) — present, it is
      // a nullable string. The whole PRESENT block is typed strictly (A9):
      // known state, boolean breakerOpen, finite non-negative restarts —
      // a truthy non-boolean breaker must never read as a false-live lane.
      (agent.supervision === null ||
        agent.supervision === undefined ||
        (isRecord(agent.supervision) &&
          isSupervisionState(agent.supervision.state) &&
          typeof agent.supervision.breakerOpen === 'boolean' &&
          isRestartCount(agent.supervision.restarts) &&
          (agent.supervision.stopReason === undefined ||
            agent.supervision.stopReason === null ||
            typeof agent.supervision.stopReason === 'string') &&
          (agent.supervision.stoppedAt === undefined ||
            agent.supervision.stoppedAt === null ||
            typeof agent.supervision.stoppedAt === 'string') &&
          (agent.supervision.openTurn === undefined ||
            typeof agent.supervision.openTurn === 'boolean') &&
          (agent.supervision.openControl === undefined ||
            typeof agent.supervision.openControl === 'boolean') &&
          (agent.supervision.openToolCalls === undefined || isRestartCount(agent.supervision.openToolCalls)) &&
          (agent.supervision.lastEventAt === undefined ||
            agent.supervision.lastEventAt === null ||
            (typeof agent.supervision.lastEventAt === 'string' &&
              Number.isFinite(Date.parse(agent.supervision.lastEventAt)))))),
  );
  const notificationsOk = value.notifications.every(
    (notification) =>
      isRecord(notification) &&
      typeof notification.id === 'string' &&
      typeof notification.ts === 'string' &&
      typeof notification.kind === 'string' &&
      (notification.severity === 'info' || notification.severity === 'error') &&
      (notification.routing === 'fyi' ||
        notification.routing === 'action-required' ||
        notification.routing === 'needs-owner') &&
      typeof notification.title === 'string' &&
      (notification.detail === null || typeof notification.detail === 'string') &&
      (notification.agentId === null || typeof notification.agentId === 'string') &&
      (notification.shownAt === null || typeof notification.shownAt === 'string') &&
      (notification.ackedAt === null || typeof notification.ackedAt === 'string') &&
      (notification.resolvedAt === null || typeof notification.resolvedAt === 'string') &&
      (notification.resolvedBy === null || typeof notification.resolvedBy === 'string'),
  );
  if (!agentsOk || !notificationsOk) return false;
  return value.repos.every(
    (repo) =>
      isRecord(repo) &&
      typeof repo.name === 'string' &&
      Array.isArray(repo.jobs) &&
      repo.jobs.every(
        (job) =>
          isRecord(job) &&
          typeof job.id === 'string' &&
          typeof job.title === 'string' &&
          (job.displayName === undefined || job.displayName === null ||
            (typeof job.displayName === 'string' && job.displayName.trim() !== '' && hasVisibleCharacters(job.displayName))) &&
          typeof job.status === 'string' &&
          (job.prState === null || job.prState === undefined || isPrState(job.prState)) &&
          (job.lane === null || isLane(job.lane)) &&
          (job.lastAgentActivity === null || typeof job.lastAgentActivity === 'string') &&
          Array.isArray(job.rounds) &&
          job.rounds.every(
            (round) =>
              isRecord(round) &&
              typeof round.id === 'string' &&
              typeof round.status === 'string' &&
              typeof round.createdAt === 'string' &&
              typeof round.blockers === 'number' &&
              Number.isSafeInteger(round.blockers) &&
              round.blockers >= 0 &&
              Array.isArray(round.lensAttempts) &&
              round.lensAttempts.every(isLensAttempt) &&
              Array.isArray(round.lenses) &&
              round.lenses.every(
                (chip) =>
                  isRecord(chip) &&
                  typeof chip.lens === 'string' &&
                  typeof chip.state === 'string' &&
                  (chip.verdict === null || typeof chip.verdict === 'string'),
              ),
          ),
      ),
  );
}

/** Shape helpers shared by the views (defensive against schema drift). */
export function agentViewOf(agent: AgentView): { id: string; role: string; state: string } {
  return { id: agent.id, role: agent.role, state: agent.state };
}

/** Issue #171 runtime membership, with the pre-upgrade fallback: a
 * server that cannot classify reports nothing and the board keeps the
 * row visible and explicitly ambiguous (`unverified`) — it never guesses
 * the record historical (visible-only evidence is not death evidence). */
export function agentRuntimeOf(agent: AgentView): 'current' | 'historical' | 'unverified' {
  return agent.runtime ?? 'unverified';
}

/** Issue #171 truthful display status, with the pre-upgrade fallback to
 * the raw adapter state. */
export function agentStatusOf(agent: AgentView): string {
  return agent.status ?? agent.state;
}

/** Issue #171: whether this snapshot carries runtime classification AT ALL
 * (a pre-upgrade server sends none on any row). The board then keeps the
 * legacy attribution rules — every non-disposed row is live crew — so an
 * unclassified board never silently drops rows from its counts. */
export function hasRuntimeClassification(agents: readonly AgentView[]): boolean {
  return agents.some((agent) => agent.runtime !== undefined);
}

/** Issue #171: the rail band one agent renders in. An owner-held stop or
 * restart (supervision view present) stays in the LIVE crew even when the
 * released handle left the ledger state `disposed`: the current runtime
 * still owns the lane and waits on the owner's re-arm. */
export function agentRailBand(agent: AgentView): 'live' | 'historical' | 'disposed' {
  const supervision = agent.supervision;
  const ownerHeld =
    supervision !== null &&
    supervision !== undefined &&
    (supervision.state === 'stopped' || supervision.state === 'restarting');
  if (agent.state === 'disposed' && !ownerHeld) return 'disposed';
  if (agentRuntimeOf(agent) === 'historical') return 'historical';
  return 'live';
}

/** Issue #171: whether a live-band row counts as CONFIRMED crew. On a
 * classifying server only `current` owners count — an unverified row is
 * visible with its explicit mark but is never claimed active, so the
 * active count cannot overstate what the runtime proves. A pre-upgrade
 * server (no classification at all) keeps today's attribution. */
export function isCountedCrewAgent(agent: AgentView, classificationPresent: boolean): boolean {
  if (!classificationPresent) return true;
  return agentRuntimeOf(agent) === 'current';
}

/** Issue #171: the freshest known activity stamp for a working row — the
 * newer of the ledger's last_activity and the supervision event clock
 * (deltas never touch the ledger, and a ledger write can lag the event
 * stream; the newer parseable stamp wins). */
export function agentActivityOf(agent: AgentView): string | null {
  const supervision = agent.supervision;
  const eventAt =
    supervision !== null && supervision !== undefined ? (supervision.lastEventAt ?? null) : null;
  if (eventAt === null) return agent.lastActivity;
  if (agent.lastActivity === null) return eventAt;
  const ledgerMs = Date.parse(agent.lastActivity);
  const eventMs = Date.parse(eventAt);
  if (!Number.isFinite(eventMs)) return agent.lastActivity;
  if (!Number.isFinite(ledgerMs)) return eventAt;
  return eventMs >= ledgerMs ? eventAt : agent.lastActivity;
}

/** One presentation classification for every lens chip. A lens recorded
 * `done` with the canonical note (`not used — …`) never ran: it is
 * `unused` — settled, never a pass. Only that canonical record downgrades,
 * and it downgrades to neutral, not to success. `lensChipTone`, the chip
 * icon/wording and `roundSummary` all read this result so they cannot
 * disagree; unknown states pass through so the defensive `?` + park
 * rendering still applies — except a raw `unused` state string, which is
 * renamed aside (`unrecognized`) so schema drift can never collide with
 * the derived value, steal the `—` marker, or distort used/ran counts. */
export function lensChipState(lens: Pick<LensChipView, 'state' | 'note'>): string {
  if (lens.state === 'done' && lens.note !== null && lens.note.startsWith('not used')) return 'unused';
  return lens.state === 'unused' ? 'unrecognized' : lens.state;
}

export function lensChipTone(state: string): string {
  switch (state) {
    case 'live':
      return 'pp-chip--work';
    case 'done':
      return 'pp-chip--done';
    case 'unused':
      return 'pp-chip--unused';
    case 'error':
      return 'pp-chip--alert';
    default:
      return 'pp-chip--park';
  }
}

/** One status → tone mapping for every surface that renders it (chip
 * fills, job-row dots): a status can never be two colors in one view. */
export type JobTone = 'work' | 'rev' | 'done' | 'alert' | 'park' | 'binned' | 'none';

export function jobStatusTone(status: string): JobTone {
  switch (status) {
    case 'working':
    case 'dispatched':
    case 'delivered':
      return 'work';
    case 'in-review':
      return 'rev';
    case 'merged':
    case 'done':
      return 'done';
    case 'blocked':
    case 'error':
      return 'alert';
    case 'parked':
      return 'park';
    case 'binned':
      // Discarded terminal lane: a distinct badge, never the parked fill
      // (resumable) or the success fill (merged/done).
      return 'binned';
    default:
      return 'none';
  }
}

export function jobChipTone(status: string): string {
  const tone = jobStatusTone(status);
  return tone === 'none' ? '' : `pp-chip--${tone}`;
}

export function agentStateTone(state: string): string {
  switch (state) {
    case 'streaming':
      return 'pp-chip--work';
    case 'idle':
      return 'pp-chip--done';
    case 'error':
      return 'pp-chip--alert';
    case 'spawning':
      return 'pp-chip--park';
    default:
      return 'pp-chip--park';
  }
}

/** A terminal job (merged/done/binned) is a closed receipt: it can never
 * be live Gru work, so no leftover unacked escalation row, aborted
 * historical round, or stale lens noise may promote it back into NEEDS
 * YOU. Shared by the banding and signal derivations — the web twin of the
 * ledger's `isJobTerminal` (separate builds; keep the two in step; the
 * `board-signals` cross-build alarm fails when the ledger terminal set
 * changes without this mirror). */
export function isJobConcluded(status: string): boolean {
  return status === 'merged' || status === 'done' || status === 'binned';
}

export { str as boardStr, nstr as boardNstr };
