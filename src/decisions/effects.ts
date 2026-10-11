import { BACKTEST_SURFACES, surfaceCaseSpec } from './cases/registry.js';
import {
  DECISION_SURFACE_EVENT_TRIAGE,
  DECISION_SURFACE_SUPERVISION,
  EVENT_QUESTIONS,
  SUPERVISION_QUESTIONS,
  type EventQuestions,
  type FailureClass,
  type SupervisionQuestions,
} from './questions.js';
import type {
  Answer,
  AnswersFor,
  DecisionOutcome,
  DecisionProvenance,
  DecisionRoute,
  Question,
  QuestionSet,
} from './types.js';

/**
 * What production consumers DO with a decision outcome (2026-10-11).
 * The consumers call these functions, and the shadow recorder and the
 * yield report call the same ones on the provider's and the baseline's
 * outcomes, so a shadow disagreement means exactly "the consumer would
 * have acted differently" and cannot drift from the consumers.
 */

/** The parts of an outcome a consumer reads. */
export type OutcomeView<Q extends QuestionSet> = Pick<DecisionOutcome<Q>, 'answers' | 'routes'> & {
  readonly provenance: Pick<DecisionProvenance, 'source'>;
};

/** The answers a consumer reads: a `fallback`-band route serves the
 * deterministic answer; any band at or above `confirm` serves the
 * provider's. */
export function servedAnswers<Q extends QuestionSet>(
  fallback: AnswersFor<Q>,
  outcome: Pick<DecisionOutcome<Q>, 'answers' | 'routes'>,
): AnswersFor<Q> {
  return Object.fromEntries(Object.keys(fallback).map((id) => [
    id,
    outcome.routes[id]?.path === 'fallback' ? fallback[id] : outcome.answers[id],
  ])) as AnswersFor<Q>;
}

export type EventTriageRouting = 'action-required' | 'fyi';

/** Event triage (`notifications/center.ts`). Jev may only route UP: a
 * provider answer whose `needs_action` route clears the fallback band
 * promotes the notification to action-required. A deterministic
 * provenance or a fallback-band action metric leaves the safe FYI route
 * in place (fail toward attention). The class and severity answers only
 * annotate the notification's detail text. */
export function eventTriageRouting(outcome: OutcomeView<EventQuestions>): EventTriageRouting {
  return outcome.provenance.source === 'jev' && outcome.routes.needs_action.path !== 'fallback'
    ? 'action-required'
    : 'fyi';
}

/** What the supervisor does next: run the restart rung (when the caller
 * allows restarts) or stop the agent for guidance with `reason`. */
export type SupervisionAction =
  | { readonly kind: 'restart' }
  | { readonly kind: 'stop'; readonly reason: string };

export interface SupervisionGuidance {
  readonly failureClass: FailureClass;
  readonly restartAdvised: boolean;
  readonly restartAuthorized: boolean;
  readonly action: SupervisionAction;
}

const isWall = (failureClass: FailureClass): boolean =>
  failureClass === 'authentication_wall' || failureClass === 'quota_wall';

/** Supervision guidance (`supervision/supervisor.ts`). `deterministicClass`
 * is `deterministicFailureClass(reason)` — the same class the request's
 * baseline answer carries. */
export function supervisionGuidance(
  fallback: AnswersFor<SupervisionQuestions>,
  outcome: OutcomeView<SupervisionQuestions>,
  deterministicClass: FailureClass,
): SupervisionGuidance {
  const served = servedAnswers<SupervisionQuestions>(fallback, outcome);
  // Model guidance may refine unknown/transient failures, but it cannot
  // contradict a provider wall that is already evident in the runtime
  // error. Burning restart rungs on known auth/quota walls is futile.
  const failureClass = isWall(deterministicClass) ? deterministicClass : served.failure_class.choice;
  const classifiedWall = isWall(failureClass);
  const restartAdvised = classifiedWall ? false : served.restart_advised.noul >= 0.5;
  const restartRoute = outcome.routes.restart_advised;
  const restartAuthorized =
    restartAdvised && restartRoute.path === 'act' && restartRoute.requiresConfirm === false;
  const action: SupervisionAction =
    // A wall stops unconditionally: model advice never burns rungs on it.
    classifiedWall ? { kind: 'stop', reason: failureClass }
    // THE GRANT LEG: a high-confidence act-band answer yields the same
    // unattended restart the deterministic ladder would have run — no
    // human ack required, no escalation row.
    : restartAuthorized ? { kind: 'restart' }
    // Uncertain advice is not a stop order: low confidence falls back to
    // the exact deterministic behavior (the ladder) the no-service path
    // would run, instead of stopping an agent the ladder would restart.
    : restartRoute.path === 'fallback' ? { kind: 'restart' }
    // Confirm band (or act with requireConfirm): the human gate owns it.
    : { kind: 'stop', reason: restartAdvised ? 'restart_confirmation_required' : failureClass };
  return { failureClass, restartAdvised, restartAuthorized, action };
}

/** One surface's consumer effect, reduced to a comparable key, and the
 * surface's question set. An outcome that does not carry a readable
 * answer of the right type for every question cannot be measured. */
interface ShadowEffect {
  readonly questions: QuestionSet;
  readonly effect: (fallback: AnswersFor<QuestionSet>, outcome: OutcomeView<QuestionSet>) => string;
}

function caseSpecEffect(surface: string): ShadowEffect {
  const spec = surfaceCaseSpec(surface);
  return {
    questions: spec.questions,
    effect: (fallback, outcome) => spec.answerAction(servedAnswers(fallback, outcome)),
  };
}

const SHADOW_EFFECTS: Readonly<Record<string, ShadowEffect>> = {
  [DECISION_SURFACE_EVENT_TRIAGE]: {
    questions: EVENT_QUESTIONS,
    effect: (_fallback, outcome) => eventTriageRouting(outcome as unknown as OutcomeView<EventQuestions>),
  },
  [DECISION_SURFACE_SUPERVISION]: {
    questions: SUPERVISION_QUESTIONS,
    effect: (fallback, outcome) => {
      const baseline = fallback as unknown as AnswersFor<SupervisionQuestions>;
      const { action } = supervisionGuidance(
        baseline,
        outcome as unknown as OutcomeView<SupervisionQuestions>,
        baseline.failure_class.choice,
      );
      return action.kind === 'restart' ? 'restart' : `stop:${action.reason}`;
    },
  },
  // Shadow-only surfaces (#224 wires enforce): the backtest case spec's
  // `answerAction` is their operational action contract.
  ...Object.fromEntries(BACKTEST_SURFACES.map((surface) => [surface, caseSpecEffect(surface)])),
};

/** True when a consumer effect is defined for `surface`. */
export function hasShadowEffect(surface: string): boolean {
  return Object.hasOwn(SHADOW_EFFECTS, surface);
}

const ROUTE_PATHS: ReadonlySet<string> = new Set(['act', 'confirm', 'fallback']);

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readableAnswer(question: Question, value: unknown): value is Answer {
  if (!plainRecord(value) || value['type'] !== question.type) return false;
  if (question.type === 'choice') return typeof value['choice'] === 'string' && question.options.includes(value['choice']);
  if (question.type === 'noul') return typeof value['noul'] === 'number' && Number.isFinite(value['noul']);
  return typeof value['score'] === 'number' && Number.isFinite(value['score']);
}

function readableRoute(value: unknown): value is DecisionRoute {
  return plainRecord(value) &&
    typeof value['path'] === 'string' && ROUTE_PATHS.has(value['path']) &&
    typeof value['requiresConfirm'] === 'boolean';
}

/** Read recorded answers and routes for every question; null when any
 * is missing, unreadable, or of the wrong type. */
function readOutcome(
  questions: QuestionSet,
  answers: unknown,
  routes: unknown,
  source: unknown,
): OutcomeView<QuestionSet> | null {
  if (!plainRecord(answers) || !plainRecord(routes)) return null;
  if (source !== 'jev' && source !== 'deterministic') return null;
  for (const [id, question] of Object.entries(questions)) {
    if (!readableAnswer(question, answers[id]) || !readableRoute(routes[id])) return null;
  }
  return {
    answers: answers as AnswersFor<QuestionSet>,
    routes: routes as OutcomeView<QuestionSet>['routes'],
    provenance: { source },
  };
}

/** True when the consumer of `surface` would act differently on the
 * provider's outcome than on the deterministic baseline's. Null when no
 * consumer effect is defined for the surface, or when the recorded
 * answers or routes do not readably carry every question the effect
 * reads. Pure; shared by the shadow recorder and the yield telemetry so
 * "disagreement" has exactly one definition. */
export function shadowEffectDisagreement(input: {
  readonly surface: string;
  readonly baselineAnswers: unknown;
  readonly baselineRoutes: unknown;
  readonly providerAnswers: unknown;
  readonly providerRoutes: unknown;
  readonly providerSource: unknown;
}): boolean | null {
  if (!hasShadowEffect(input.surface)) return null;
  const { questions, effect } = SHADOW_EFFECTS[input.surface]!;
  const baseline = readOutcome(questions, input.baselineAnswers, input.baselineRoutes, 'deterministic');
  const provider = readOutcome(questions, input.providerAnswers, input.providerRoutes, input.providerSource);
  if (baseline === null || provider === null) return null;
  return effect(baseline.answers, provider) !== effect(baseline.answers, baseline);
}
