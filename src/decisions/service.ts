import type {
  Answer,
  AnswersFor,
  DecisionFailureReason,
  DecisionOutcome,
  DecisionRequest,
  DecisionRoute,
  DecisionService,
  Question,
  QuestionSet,
  RiskClass,
  RiskThresholds,
  ThresholdsConfig,
} from './types.js';

function finiteUnit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number between 0 and 1`);
  }
  return value;
}

export function validateThresholds(thresholds: RiskThresholds, label = 'thresholds'): void {
  const act = finiteUnit(thresholds.act, `${label}.act`);
  const confirm = finiteUnit(thresholds.confirm, `${label}.confirm`);
  if (confirm >= act) {
    throw new Error(`${label}.confirm (${confirm}) must be less than ${label}.act (${act})`);
  }
  if (typeof thresholds.requireConfirmOnAct !== 'boolean') {
    throw new Error(`${label}.requireConfirmOnAct must be a boolean`);
  }
}

export function validateThresholdConfig(config: ThresholdsConfig): void {
  for (const risk of ['read_only', 'operational', 'destructive'] as const) {
    validateThresholds(config[risk], `decisions.thresholds.${risk}`);
  }
  if (!config.destructive.requireConfirmOnAct) {
    throw new Error('decisions.thresholds.destructive.require_confirm_on_act must be true');
  }
}

export function decisionRoute(
  answer: Answer,
  riskClass: RiskClass,
  thresholds: ThresholdsConfig,
): DecisionRoute {
  const selected = thresholds[riskClass];
  validateThresholds(selected, `decisions.thresholds.${riskClass}`);
  const metricKind = answer.type === 'noul' ? 'probability' : 'confidence';
  const metric = finiteUnit(
    answer.type === 'noul' ? answer.noul : answer.confidence,
    answer.type === 'noul' ? 'answer.noul' : 'answer.confidence',
  );
  const path = metric >= selected.act ? 'act' : metric >= selected.confirm ? 'confirm' : 'fallback';
  return {
    path,
    metric,
    metricKind,
    requiresConfirm:
      path === 'confirm' || (path === 'act' && selected.requireConfirmOnAct),
    riskClass,
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(actual: readonly string[], expected: readonly string[], field: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length !== e.length || a.some((key, index) => key !== e[index])) {
    throw new Error(`${field} must contain exactly: ${e.join(', ')}`);
  }
}

function validateDistribution(
  value: unknown,
  expected: readonly string[],
  field: string,
): Readonly<Record<string, number>> {
  if (!plainRecord(value)) throw new Error(`${field} must be a probability record`);
  exactKeys(Object.keys(value), expected, field);
  const out: Record<string, number> = {};
  for (const key of expected) out[key] = finiteUnit(value[key], `${field}.${key}`);
  const sum = Object.values(out).reduce((total, probability) => total + probability, 0);
  if (Math.abs(sum - 1) > 0.001) {
    throw new Error(`${field} must sum to 1`);
  }
  return out;
}

export function validateQuestionSet(questions: QuestionSet): void {
  const entries = Object.entries(questions);
  if (entries.length === 0) throw new Error('questions must not be empty');
  for (const [id, question] of entries) {
    if (id.trim() === '') throw new Error('question id must not be empty');
    if (question.instructions.trim() === '') throw new Error(`question ${id}: instructions must not be empty`);
    if (question.type === 'noul') {
      if (question.criteria !== undefined) {
        if (question.criteria.true.trim() === '' || question.criteria.false.trim() === '') {
          throw new Error(`question ${id}: noul criteria must describe true and false`);
        }
      }
      continue;
    }
    if (question.type === 'choice') {
      if (question.options.length < 2 || new Set(question.options).size !== question.options.length) {
        throw new Error(`question ${id}: choice options must contain at least two unique values`);
      }
      exactKeys(Object.keys(question.criteria), question.options, `question ${id}.criteria`);
      if (question.options.some((option) => question.criteria[option]?.trim() === '')) {
        throw new Error(`question ${id}: every choice criterion must be non-empty`);
      }
      continue;
    }
    if (question.criteria.length < 2 || question.criteria.some((criterion) => criterion.trim() === '')) {
      throw new Error(`question ${id}: score criteria need at least two non-empty ordered levels`);
    }
  }
}

export function validateAnswer(question: Question, raw: unknown, id: string): Answer {
  if (!plainRecord(raw) || raw.type !== question.type) {
    throw new Error(`answer ${id}: type must be ${question.type}`);
  }
  if (question.type === 'noul') {
    exactKeys(Object.keys(raw), ['type', 'noul'], `answer ${id}`);
    return { type: 'noul', noul: finiteUnit(raw.noul, `answer ${id}.noul`) };
  }
  if (question.type === 'choice') {
    exactKeys(Object.keys(raw), ['type', 'choice', 'probabilities', 'confidence'], `answer ${id}`);
    if (typeof raw.choice !== 'string' || !question.options.includes(raw.choice)) {
      throw new Error(`answer ${id}.choice is not one of the requested options`);
    }
    return {
      type: 'choice',
      choice: raw.choice,
      probabilities: validateDistribution(raw.probabilities, question.options, `answer ${id}.probabilities`),
      confidence: finiteUnit(raw.confidence, `answer ${id}.confidence`),
    };
  }
  const required = ['type', 'score', 'probabilities', 'confidence'];
  const keys = Object.keys(raw);
  const missing = required.filter((key) => !keys.includes(key));
  const unexpected = keys.filter((key) => ![...required, 'legend'].includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`answer ${id} has an incompatible score schema`);
  }
  // The TypeSafe API returns a probability-weighted value that can land
  // BETWEEN rubric levels (docs.typesafe.ai/api: e.g. 1.05 on a 3-level
  // rubric). Accept any finite score inside the rubric range; integer
  // levels remain the common case, never a requirement.
  if (
    typeof raw.score !== 'number' || !Number.isFinite(raw.score) ||
    raw.score < 0 || raw.score > question.criteria.length - 1
  ) {
    throw new Error(`answer ${id}.score is outside the requested rubric`);
  }
  const levels = question.criteria.map((_, index) => String(index));
  let legend: Record<string, string> | undefined;
  if (raw.legend !== undefined) {
    if (!plainRecord(raw.legend)) throw new Error(`answer ${id}.legend must be a record`);
    exactKeys(Object.keys(raw.legend), levels, `answer ${id}.legend`);
    legend = {};
    for (const [index, level] of levels.entries()) {
      const value = raw.legend[level];
      if (typeof value !== 'string' || value !== question.criteria[index]) {
        throw new Error(`answer ${id}.legend does not match the requested rubric`);
      }
      legend[level] = value;
    }
  }
  return {
    type: 'score',
    score: raw.score,
    ...(legend !== undefined ? { legend } : {}),
    probabilities: validateDistribution(raw.probabilities, levels, `answer ${id}.probabilities`),
    confidence: finiteUnit(raw.confidence, `answer ${id}.confidence`),
  };
}

export function validateRequest<Q extends QuestionSet>(request: DecisionRequest<Q>): void {
  if (typeof request.state !== 'string' || request.state.trim() === '') {
    throw new Error('decision state must be a non-empty filtered string');
  }
  validateQuestionSet(request.questions);
  const ids = Object.keys(request.questions);
  exactKeys(Object.keys(request.risks), ids, 'risks');
  exactKeys(Object.keys(request.fallback), ids, 'fallback');
  for (const id of ids) {
    const question = request.questions[id];
    if (question === undefined) continue;
    validateAnswer(question, request.fallback[id], id);
  }
}

export function deterministicOutcome<Q extends QuestionSet>(
  request: DecisionRequest<Q>,
  thresholds: ThresholdsConfig,
  reason: DecisionFailureReason,
): DecisionOutcome<Q> {
  validateRequest(request);
  const routes: Record<string, DecisionRoute> = {};
  for (const id of Object.keys(request.questions)) {
    routes[id] = decisionRoute(request.fallback[id] as Answer, request.risks[id] as RiskClass, thresholds);
  }
  return {
    answers: request.fallback,
    routes: routes as DecisionOutcome<Q>['routes'],
    provenance: {
      source: 'deterministic',
      fallbackReason: reason,
      model: null,
      latencyMs: 0,
      usage: null,
    },
  };
}

export class DeterministicDecisionService implements DecisionService {
  constructor(
    private readonly thresholds: ThresholdsConfig,
    private readonly reason: DecisionFailureReason = 'disabled',
  ) {
    validateThresholdConfig(thresholds);
  }

  async decide<Q extends QuestionSet>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
    return deterministicOutcome(request, this.thresholds, this.reason);
  }
}

export function validatedAnswers<Q extends QuestionSet>(
  questions: Q,
  raw: unknown,
): AnswersFor<Q> {
  if (!plainRecord(raw)) throw new Error('response envelope missing answers object');
  exactKeys(Object.keys(raw), Object.keys(questions), 'response answers');
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    answers[id] = validateAnswer(question, raw[id], id);
  }
  return answers as AnswersFor<Q>;
}
