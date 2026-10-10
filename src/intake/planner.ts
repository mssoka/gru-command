import { isPipelineMilestone, isSafePipelineRecordId, type PipelineMilestone } from '../ledger/pipeline.js';
import { IntakeError, type Acceptance, type Capture, type Dependency, type Heist, type Plan, type Statement, type Trace } from './types.js';

function invalid(message: string): never { throw new IntakeError('intake_invalid_plan', message); }
function object(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) invalid(`${label} contains unsupported fields; statuses and approvals are not intake authority`);
  return result;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256 * 1024 || value.includes('\0')) invalid(`${label} must be bounded nonempty text`);
  return value;
}
function array(value: unknown, label: string, nonempty = false): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 4000 || (nonempty && value.length === 0)) invalid(`${label} must be ${nonempty ? 'a nonempty' : 'an'} array of at most 4000 elements`);
  return value;
}
function strings(value: unknown, label: string, nonempty = false): readonly string[] {
  return array(value, label, nonempty).map((item) => text(item, label));
}
function id(value: unknown, label: string): string {
  const result = text(value, label);
  if (!isSafePipelineRecordId(result)) invalid(`${label} must be a safe pipeline record id`);
  return result;
}
function milestone(value: unknown): PipelineMilestone {
  if (typeof value !== 'string' || !isPipelineMilestone(value)) invalid('milestone must be admitted, delivered, merged or done');
  return value;
}
export function validatePlan(value: unknown, capture: Capture): Plan {
  const requirements = new Map(capture.requirements.map((requirement) => [requirement.id, requirement]));
  const snapshots = new Map(capture.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const trace = (value: unknown): Trace => {
    const raw = object(value, 'trace', ['snapshotId', 'start', 'end', 'quote']);
    const snapshotId = text(raw['snapshotId'], 'trace.snapshotId');
    const snapshot = snapshots.get(snapshotId);
    const start = raw['start'];
    const end = raw['end'];
    const quote = text(raw['quote'], 'trace.quote');
    if (snapshot === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        (start as number) < 0 || (end as number) <= (start as number) || (end as number) > snapshot.text.length ||
        snapshot.text.slice(start as number, end as number) !== quote) invalid('trace must name an exact captured snapshot span and quote');
    return { snapshotId, start: start as number, end: end as number, quote };
  };
  const statement = (value: unknown, label: string, extra: readonly string[] = []): Statement & Record<string, unknown> => {
    const raw = object(value, label, ['text', 'traces', 'clarification', ...extra]);
    const traces = array(raw['traces'], `${label}.traces`).map(trace);
    if (typeof raw['clarification'] !== 'boolean' || (!raw['clarification'] && traces.length === 0)) invalid(`${label} requires source traces or an explicit proposed clarification`);
    return { ...raw, text: text(raw['text'], `${label}.text`), traces, clarification: raw['clarification'] };
  };
  const raw = object(value, 'plan', ['heists', 'unmapped', 'questions']);
  const mapped = new Set<string>();
  const heists: Heist[] = array(raw['heists'], 'plan.heists', capture.requirements.length > 0).map((value) => {
    const heist = object(value, 'heist', ['id', 'title', 'goal', 'scope', 'exclusions', 'acceptance', 'verification', 'milestones', 'dependencies', 'unresolvedQuestions', 'splitMergeRationale']);
    const acceptance: Acceptance[] = array(heist['acceptance'], 'heist.acceptance', true).map((value) => {
      const item = statement(value, 'acceptance', ['requirementIds']);
      const requirementIds = strings(item['requirementIds'], 'acceptance.requirementIds');
      if (!item.clarification && requirementIds.length === 0) invalid('source acceptance must identify its mapped requirements');
      if (new Set(requirementIds).size !== requirementIds.length) invalid('acceptance requirement ids must be unique');
      for (const requirementId of requirementIds) {
        const requirement = requirements.get(requirementId);
        if (requirement === undefined) invalid(`unknown requirement id ${requirementId}`);
        if (!item.traces.some((span) => span.snapshotId === requirement.trace.snapshotId && span.start <= requirement.trace.start && span.end >= requirement.trace.end)) invalid(`acceptance mapping ${requirementId} is not covered by its trace`);
        mapped.add(requirementId);
      }
      return { text: item.text, traces: item.traces, clarification: item.clarification, requirementIds };
    });
    const dependencies: Dependency[] = array(heist['dependencies'], 'heist.dependencies').map((value) => {
      const item = statement(value, 'dependency', ['id', 'milestone']);
      return { text: item.text, traces: item.traces, clarification: item.clarification, id: id(item['id'], 'dependency.id'), milestone: milestone(item['milestone']) };
    });
    if (new Set(dependencies.map((dependency) => dependency.id)).size !== dependencies.length) invalid('duplicate dependency id');
    const milestones = array(heist['milestones'], 'heist.milestones', true).map(milestone);
    if (new Set(milestones).size !== milestones.length) invalid('duplicate milestone');
    return {
      id: id(heist['id'], 'heist.id'), title: text(heist['title'], 'heist.title'),
      goal: statement(heist['goal'], 'heist.goal'),
      scope: array(heist['scope'], 'heist.scope', true).map((value) => statement(value, 'scope')),
      exclusions: array(heist['exclusions'], 'heist.exclusions', true).map((value) => statement(value, 'exclusion')),
      acceptance, verification: array(heist['verification'], 'heist.verification', true).map((value) => statement(value, 'verification')),
      milestones, dependencies, unresolvedQuestions: strings(heist['unresolvedQuestions'], 'heist.unresolvedQuestions'),
      splitMergeRationale: statement(heist['splitMergeRationale'], 'heist.splitMergeRationale'),
    };
  });
  const byId = new Map(heists.map((heist) => [heist.id, heist]));
  if (byId.size !== heists.length) invalid('heist ids must be unique');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (heist: Heist): void => {
    if (visiting.has(heist.id)) invalid(`dependency cycle at ${heist.id}`);
    if (visited.has(heist.id)) return;
    visiting.add(heist.id);
    for (const dependency of heist.dependencies) {
      const target = byId.get(dependency.id);
      if (target === undefined) invalid(`missing dependency ${dependency.id}; external work cannot be presumed satisfied`);
      if (!target.milestones.includes(dependency.milestone)) invalid(`dependency ${dependency.id} does not propose milestone ${dependency.milestone}`);
      visit(target);
    }
    visiting.delete(heist.id);
    visited.add(heist.id);
  };
  heists.forEach(visit);
  const unmapped = array(raw['unmapped'], 'plan.unmapped').map((value) => {
    const item = object(value, 'unmapped', ['requirementId', 'question']);
    const requirementId = text(item['requirementId'], 'unmapped.requirementId');
    if (!requirements.has(requirementId) || mapped.has(requirementId)) invalid(`unmapped requirement ${requirementId} is unknown or already mapped`);
    return { requirementId, question: text(item['question'], 'unmapped.question') };
  });
  const unmappedIds = new Set(unmapped.map((item) => item.requirementId));
  if (unmappedIds.size !== unmapped.length) invalid('duplicate unmapped requirement');
  for (const requirementId of requirements.keys()) {
    if (!mapped.has(requirementId) && !unmappedIds.has(requirementId)) invalid(`requirement ${requirementId} must be mapped or visibly questioned`);
  }
  return { heists, unmapped, questions: strings(raw['questions'], 'plan.questions') };
}

/** A cohesive, deliberately unresolved briefing. Text/metadata never supplies
 * approval, decomposition, completion, dependencies or verification authority. */
export function conservativePlan(capture: Capture): Plan {
  const proposed = (text: string): Statement => ({ text, traces: [], clarification: true });
  const questions = [
    'Confirm the goal, scope and exclusions; source prose, labels and statuses are untrusted data.',
    'Confirm acceptance, verification commands and dependency milestones before any separate approval.',
    'Clarify missing or contradictory requirements; this preview claims no completion.',
    ...capture.gaps.map((gap) => gap.question),
  ];
  if (capture.requirements.length === 0) return { heists: [], unmapped: [], questions };
  return {
    heists: [{
      id: 'heist-1', title: 'Proposed cohesive source heist',
      goal: proposed('Clarify the desired outcome from the captured sources.'),
      scope: [proposed('Confirm which captured requirements belong in this heist.')],
      exclusions: [proposed('Clarify explicit exclusions; none are inferred.')],
      acceptance: capture.requirements.map((requirement) => ({
        text: `Clarify whether source requirement ${requirement.id} is acceptance, context or an exclusion.`,
        traces: [requirement.trace], clarification: true, requirementIds: [requirement.id],
      })),
      verification: [proposed('Specify deterministic verification for each confirmed acceptance; no commands have been run.')],
      milestones: ['delivered'], dependencies: [], unresolvedQuestions: questions,
      splitMergeRationale: proposed('Keep one cohesive heist until validated scope demonstrates independent deliverables; headings and BMAD epic boundaries alone do not justify splits.'),
    }], unmapped: [], questions,
  };
}
