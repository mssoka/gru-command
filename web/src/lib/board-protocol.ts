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

export interface AgentView {
  readonly id: string;
  readonly role: string;
  readonly label: string | null;
  readonly state: string;
  readonly lastActivity: string | null;
  readonly sessionFile: string | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
  /** E7 supervision view (null when unsupervised). */
  readonly supervision: {
    readonly state: 'watching' | 'restarting' | 'stopped';
    readonly restarts: number;
    readonly breakerOpen: boolean;
  } | null;
}

export interface NotificationView {
  readonly id: string;
  readonly ts: string;
  readonly kind: string;
  readonly routing: 'fyi' | 'action-required';
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

/** Silas ops health (board UX v4), derived from the durable event stream. */
export interface SilasView {
  readonly lastWakeAt: string | null;
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

/** Self-healing session stats (board UX v4; null until a producer exists). */
export interface SelfHealView {
  readonly sessionsResumed: number;
  readonly sessionsOrphaned: number;
  readonly since: string | null;
}

export interface BoardSnapshot {
  readonly repos: readonly { readonly name: string; readonly jobs: readonly JobView[] }[];
  readonly agents: readonly AgentView[];
  readonly notifications: readonly NotificationView[];
  readonly decisions: DecisionStatusView;
  readonly unackedActionRequired: number;
  /** Absent on pre-v4 servers (validator tolerates; consumers render n/a). */
  readonly build?: BuildView | null;
  readonly silas?: SilasView | null;
  readonly verify?: VerifyQueueView | null;
  readonly selfHeal?: SelfHealView | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function isSelfHealView(value: unknown): value is SelfHealView {
  return (
    isRecord(value) &&
    (typeof value.sessionsResumed === 'number' && Number.isSafeInteger(value.sessionsResumed) && value.sessionsResumed >= 0) &&
    (typeof value.sessionsOrphaned === 'number' && Number.isSafeInteger(value.sessionsOrphaned) && value.sessionsOrphaned >= 0) &&
    (value.since === null || typeof value.since === 'string')
  );
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
    value.unackedActionRequired < 0
  ) {
    return false;
  }
  // v4 blocks are absent on pre-v4 servers (tolerated) but a present
  // block must match its shape — a malformed health read is a server bug.
  if (value.build !== undefined && value.build !== null && !isBuildView(value.build)) return false;
  if (value.silas !== undefined && value.silas !== null && !isSilasView(value.silas)) return false;
  if (value.verify !== undefined && value.verify !== null && !isVerifyQueueView(value.verify)) return false;
  if (value.selfHeal !== undefined && value.selfHeal !== null && !isSelfHealView(value.selfHeal)) return false;
  const agentsOk = value.agents.every(
    (agent) =>
      isRecord(agent) &&
      typeof agent.id === 'string' &&
      typeof agent.role === 'string' &&
      typeof agent.state === 'string' &&
      // supervision is optional (null when the agent is unsupervised)
      (agent.supervision === null ||
        agent.supervision === undefined ||
        (isRecord(agent.supervision) && typeof agent.supervision.state === 'string')),
  );
  const notificationsOk = value.notifications.every(
    (notification) =>
      isRecord(notification) &&
      typeof notification.id === 'string' &&
      typeof notification.ts === 'string' &&
      typeof notification.kind === 'string' &&
      (notification.severity === 'info' || notification.severity === 'error') &&
      (notification.routing === 'fyi' || notification.routing === 'action-required') &&
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

export function lensChipTone(state: string): string {
  switch (state) {
    case 'live':
      return 'pp-chip--work';
    case 'done':
      return 'pp-chip--done';
    case 'error':
      return 'pp-chip--alert';
    default:
      return 'pp-chip--park';
  }
}

export function jobChipTone(status: string): string {
  switch (status) {
    case 'working':
    case 'dispatched':
    case 'delivered':
      return 'pp-chip--work';
    case 'in-review':
      return 'pp-chip--rev';
    case 'merged':
    case 'done':
      return 'pp-chip--done';
    case 'blocked':
      return 'pp-chip--alert';
    case 'parked':
      return 'pp-chip--park';
    default:
      return '';
  }
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

export { str as boardStr, nstr as boardNstr };
