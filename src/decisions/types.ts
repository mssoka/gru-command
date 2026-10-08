export const RISK_CLASSES = ['read_only', 'operational', 'destructive'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export interface RiskThresholds {
  readonly act: number;
  readonly confirm: number;
  readonly requireConfirmOnAct: boolean;
}

export type ThresholdsConfig = Readonly<Record<RiskClass, RiskThresholds>>;

export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria?: Readonly<{ true: string; false: string }>;
}

export interface ChoiceQuestion<Choice extends string = string> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly options: readonly Choice[];
  readonly criteria: Readonly<Record<Choice, string>>;
}

export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type QuestionSet = Readonly<Record<string, Question>>;

/** Noul intentionally has no confidence field: its probability is the gate. */
export interface NoulAnswer {
  readonly type: 'noul';
  readonly noul: number;
}

export interface ChoiceAnswer<Choice extends string = string> {
  readonly type: 'choice';
  readonly choice: Choice;
  readonly probabilities: Readonly<Record<Choice, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  /** Provider echoes the ordered rubric as a numeric-key legend. */
  readonly legend?: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type AnswerFor<Q extends Question> =
  Q extends NoulQuestion ? NoulAnswer :
    Q extends ChoiceQuestion<infer C> ? ChoiceAnswer<C> : ScoreAnswer;
export type AnswersFor<Q extends QuestionSet> = Readonly<{ [K in keyof Q]: AnswerFor<Q[K]> }>;

export type RoutePath = 'act' | 'confirm' | 'fallback';

export interface DecisionRoute {
  readonly path: RoutePath;
  readonly metric: number;
  readonly metricKind: 'probability' | 'confidence';
  readonly requiresConfirm: boolean;
  readonly riskClass: RiskClass;
}

export type DecisionFailureReason =
  | 'disabled'
  | 'shadow_mode'
  | 'credential_missing'
  | 'credential_unsafe'
  | 'credential_invalid'
  | 'config_invalid'
  | 'endpoint_untrusted'
  | 'auth_rejected'
  | 'forbidden'
  | 'timeout'
  | 'network_error'
  | 'malformed_response'
  | 'malformed_request'
  | 'provider_degraded'
  | 'capacity_limited'
  | 'probe_failed'
  | 'stale_generation'
  | 'disposed';

export interface DecisionUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

/** Client-side milestones, never provider inference timings. `request`
 * includes local scheduling, connection setup and waiting for headers;
 * fetch does not expose separate DNS/TCP/TLS/model timings here. */
export interface DecisionRequestDiagnostics {
  readonly phase: 'not_started' | 'request' | 'response_headers' | 'response_body' | 'response_validation';
  readonly timeoutMs: number;
  readonly deadlineExpired: boolean;
  /** Elapsed from request start, not durations of individual phases. */
  readonly headersMs: number | null;
  readonly bodyMs: number | null;
  readonly httpStatus: number | null;
}

export interface DecisionProvenance {
  readonly source: 'deterministic' | 'jev';
  readonly fallbackReason: DecisionFailureReason | null;
  readonly model: string | null;
  readonly latencyMs: number;
  readonly usage: DecisionUsage | null;
  /** Present for provider calls/refusals; absent for deterministic stand-ins. */
  readonly diagnostics?: DecisionRequestDiagnostics;
  /** The `[decisions.providers]` profile that produced (or was attempted
   * for) this outcome; null for deterministic fallbacks that never named
   * one. */
  readonly profile: string | null;
}

/** Optional routing input: which `[decisions.surfaces]` entry decides the
 * provider profile. Omitted surfaces route to the default profile
 * (`openrouter-jev`) — today's behavior, unchanged. */
export interface DecisionSurface {
  readonly surface?: string;
}

/** Per-surface execution mode (issue #223).
 *
 * - `off`: deterministic only; no provider call.
 * - `shadow`: the provider is asked and its answer RECORDED next to the
 *   deterministic baseline, but the caller still receives the
 *   deterministic outcome — behavior cannot change while evidence
 *   accumulates.
 * - `enforce`: the provider's answer routes the decision (today's
 *   behavior) and the surface must present a recorded backtest result
 *   meeting its stated threshold (`<data_dir>/decisions/backtests/
 *   <surface>.json`); without one the request fails loud.
 *
 * A surface whose config entry omits `mode` keeps its pre-#223 behavior
 * (the `enforce` semantics) WITHOUT the gate: the gate protects a
 * deliberate operator switch, not a legacy default. */
export type SurfaceMode = 'off' | 'shadow' | 'enforce';
export const SURFACE_MODES: readonly SurfaceMode[] = ['off', 'shadow', 'enforce'];

/** One `decisions.shadow` ledger event payload (issue #223). Records what
 * the provider WOULD have done next to the deterministic baseline. The
 * filtered request state is NEVER recorded — `request_hash` (sha256 over
 * the filtered state plus the question ids) is the only request
 * identifier. */
export interface ShadowDecisionRecord {
  readonly surface: string;
  readonly request_hash: string;
  /** The `[decisions.providers]` profile that was asked. */
  readonly provider: string;
  /** The model that answered (null when the provider fell back before
   * naming one). */
  readonly model: string | null;
  /** The provider's (or its fallback's) answers and routes — what WOULD
   * have happened under enforce. */
  readonly answers: unknown;
  readonly routes: unknown;
  /** The deterministic baseline answers — what actually happened. */
  readonly deterministic_answers: unknown;
  readonly latency_ms: number;
  readonly cost: number | null;
  readonly provenance_source: 'jev' | 'deterministic';
  /** Exact cause of a fallback, null when Jev answered. Historical rows
   * predating this field have unknown causes — never infer timeout from 0 ms. */
  readonly fallback_reason: DecisionFailureReason | null;
  readonly request_diagnostics: DecisionRequestDiagnostics | null;
  /** True when the provider's routes would have differed from the
   * deterministic baseline's routes on at least one question. */
  readonly disagrees: boolean;
}

export interface DecisionRequest<Q extends QuestionSet> {
  /** Filtered state only. Never pass credentials or whole transcripts. */
  readonly state: string;
  readonly questions: Q;
  /** Required for every question; omission is a programmer error. */
  readonly risks: Readonly<{ [K in keyof Q]: RiskClass }>;
  /** Always-available answer set used by the deterministic service/fallback. */
  readonly fallback: AnswersFor<Q>;
}

export interface DecisionOutcome<Q extends QuestionSet> {
  readonly answers: AnswersFor<Q>;
  readonly routes: Readonly<{ [K in keyof Q]: DecisionRoute }>;
  readonly provenance: DecisionProvenance;
}

export interface DecisionService {
  decide<Q extends QuestionSet>(request: DecisionRequest<Q>, opts?: DecisionSurface): Promise<DecisionOutcome<Q>>;
}
