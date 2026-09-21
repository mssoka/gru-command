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

export interface DecisionProvenance {
  readonly source: 'deterministic' | 'jev';
  readonly fallbackReason: DecisionFailureReason | null;
  readonly model: string | null;
  readonly latencyMs: number;
  readonly usage: DecisionUsage | null;
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
  decide<Q extends QuestionSet>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>>;
}
