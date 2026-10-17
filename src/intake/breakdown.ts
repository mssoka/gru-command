import { parse } from 'smol-toml';
import { canonical, IntakeError, type Acceptance, type Capture, type Heist, type Plan, type Requirement, type Snapshot, type Statement, type Trace } from './types.js';

/** The breakdown file of a BMAD v7 epic folder: `[[entry]]` tables in build order (#429). */
export const BREAKDOWN_FILE = 'tickets.toml';
const ENTRY_TYPES = ['story', 'spike', 'bug'] as const;
type EntryType = typeof ENTRY_TYPES[number];
const ENTRY_ID = /^[0-9A-Za-z]{1,64}$/u;
const ENTRY_HEADER = /^\uFEFF?[ \t]*\[\[[ \t]*entry[ \t]*\]\][ \t]*(?:#.*)?\r?$/u;
const TABLE_HEADER = /^\uFEFF?[ \t]*\[\[?[ \t]*([A-Za-z0-9_"'. \t-]+?)[ \t]*\]\]?[ \t]*(?:#.*)?\r?$/u;
const REQUIREMENTS_HEADING = /^(#{1,6})[ \t]+requirements[ \t]*#*[ \t]*\r?$/iu;
const SOURCE_CONFLICT = /^\uFEFF?[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?source conflict(?:\*\*|__)?[ \t]*:/iu;
// Mapped once, on the first entry: every briefing already carries all
// captured sources, so repeating these spans per heist only spends the
// approval's briefing budget.
const CONTEXT_TEXT = "Epic context for the whole breakdown, mapped here once and not this entry's own deliverable: the captured lines this traces (frontmatter, title, description, outcome, Done when, boundaries, references, notes) frame every entry. The epic's Done when is the owner's end check across all entries.";

export interface BreakdownProblem {
  readonly code: 'intake_malformed_breakdown' | 'intake_breakdown_prerequisite' | 'intake_breakdown_cycle';
  readonly detail: string;
}
/** One breakdown entry, from a v7 `tickets.toml` table or a planning minion's
 * slicing output. Both paths map to heists through `toPlan` alone. */
interface BreakdownEntry {
  readonly key: string;
  readonly type: EntryType;
  readonly title: string;
  readonly description: string;
  readonly verify: string;
  readonly unknown: string;
  readonly hitl: boolean;
  readonly checkpoints: readonly ('plan' | 'done')[];
  /** Sibling keys only; prerequisites outside the breakdown are `external`. */
  readonly after: readonly string[];
  readonly external: readonly string[];
  /** The entry's own captured `tickets.toml` table; null for minion output. */
  readonly table: { readonly trace: Trace; readonly requirementIds: readonly string[] } | null;
  /** `covers` as written: epic requirement ids, or inventory ids from a minion. */
  readonly coverIds: readonly string[];
  readonly covered: readonly Requirement[];
  /** `covers` ids that name no captured epic line. */
  readonly missing: readonly string[];
  readonly clarification: boolean;
  readonly lane: string;
  readonly rationale: string;
}
interface TomlEntry extends Omit<BreakdownEntry, 'table' | 'coverIds' | 'covered' | 'missing' | 'clarification' | 'lane' | 'rationale'> {
  readonly covers: readonly string[];
  readonly span: { readonly start: number; readonly end: number };
}
interface Line { readonly start: number; readonly end: number; readonly text: string }

function lines(text: string): Line[] {
  const result: Line[] = [];
  for (let start = 0; start <= text.length;) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    result.push({ start, end, text: text.slice(start, end) });
    if (newline === -1) break;
    start = newline + 1;
  }
  return result;
}
/** Sibling `after` edges must be acyclic; returns the first cycle's path. */
function cycle(entries: readonly { readonly key: string; readonly after: readonly string[] }[]): string | null {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (key: string): string | null => {
    if (path.includes(key)) return [...path.slice(path.indexOf(key)), key].join(' → ');
    if (done.has(key)) return null;
    path.push(key);
    for (const next of byKey.get(key)?.after ?? []) {
      const found = visit(next);
      if (found !== null) return found;
    }
    path.pop();
    done.add(key);
    return null;
  };
  for (const entry of entries) {
    const found = visit(entry.key);
    if (found !== null) return found;
  }
  return null;
}

const UPLOAD_PREFIX = /^upload:\d{10,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/u;
/** A captured document's own file name: the path's basename, or an
 * upload's original name. */
export function documentName(locator: string): string {
  return UPLOAD_PREFIX.test(locator) ? locator.replace(UPLOAD_PREFIX, '') : locator.slice(locator.lastIndexOf('/') + 1);
}
/** A captured snapshot is a breakdown by its exact file name, uploads included. */
export function isBreakdownLocator(locator: string): boolean {
  return (UPLOAD_PREFIX.test(locator) || !locator.startsWith('upload:')) && documentName(locator) === BREAKDOWN_FILE;
}
/** An architecture document: a BMAD v7 spine (`type: architecture-spine`)
 * or a Markdown file named `architecture*.md`. Its captured bytes bind every
 * heist of the proposal. */
export function isArchitectureSnapshot(snapshot: Pick<Snapshot, 'kind' | 'locator' | 'frontmatter'>): boolean {
  if (snapshot.kind !== 'spec' && snapshot.kind !== 'bmad') return false;
  return /^architecture[^/]*\.md$/iu.test(documentName(snapshot.locator)) ||
    /^type[ \t]*:[ \t]*(['"]?)architecture(?:-spine)?\1[ \t]*(?:#.*)?\r?$/mu.test(snapshot.frontmatter ?? '');
}
/** Architecture documents a source names: `architecture*.md` paths anywhere
 * in a Markdown document (References, v6 `inputDocuments`) and in a
 * breakdown's `references`. Compared by file name. */
export function referencedArchitecture(snapshot: Snapshot): readonly string[] {
  const names = [...snapshot.text.matchAll(/(?:^|[\s"'`([<,=])((?:[\w.-]+\/)*architecture[\w.-]*\.md)(?=[\s"'`)\]>,#:;]|$)/giu)].map((match) => match[1]!);
  return [...new Set(names.map((name) => name.slice(name.lastIndexOf('/') + 1)))];
}

/** Parse one epic's `tickets.toml` as BMAD v7 writes it. Every problem is
 * named; a breakdown with any problem maps to no heists. */
export function parseBreakdown(text: string): { readonly entries: readonly TomlEntry[]; readonly problems: readonly BreakdownProblem[] } {
  const problems: BreakdownProblem[] = [];
  const malformed = (detail: string): void => { problems.push({ code: 'intake_malformed_breakdown', detail }); };
  const done = (entries: readonly TomlEntry[] = []) => ({ entries: problems.length === 0 ? entries : [], problems });
  let data: Record<string, unknown>;
  try {
    data = parse(text.startsWith('\uFEFF') ? text.slice(1) : text) as Record<string, unknown>;
  } catch (error) {
    malformed(`${BREAKDOWN_FILE} is not valid TOML: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
    return done();
  }
  if (Object.hasOwn(data, 'epic')) malformed(`${BREAKDOWN_FILE} lists [[epic]] tables, an initiative breakdown; intake slices one epic, so supply that epic's own ${BREAKDOWN_FILE}`);
  const rows = data['entry'];
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))) {
    malformed(`${BREAKDOWN_FILE} has no [[entry]] tables; write one [[entry]] table per planned story, spike or bug`);
    return done();
  }
  const keyOf = (value: unknown): string | null => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    // A quoted all-digit id is the same id as the bare number (BMAD).
    if (typeof value === 'string' && ENTRY_ID.test(value)) return /^\d+$/u.test(value) ? value.replace(/^0+(?=\d)/u, '') : value;
    return null;
  };
  const parsed = (rows as Record<string, unknown>[]).map((row, index) => {
    const where = `${BREAKDOWN_FILE} entry ${index + 1}`;
    const key = keyOf(row['id']);
    if (key === null) malformed(`${where} needs an id: a whole number, or letters and digits`);
    const label = `${BREAKDOWN_FILE} entry ${key ?? index + 1}`;
    const type = row['type'];
    if (!ENTRY_TYPES.includes(type as EntryType)) malformed(`${label} type ${JSON.stringify(type ?? null)} is not one of ${ENTRY_TYPES.join(', ')}`);
    const title = row['title'];
    if (typeof title !== 'string' || title.trim() === '') malformed(`${label} needs a title`);
    const textField = (name: string): string => {
      const value = row[name];
      if (value === undefined) return '';
      if (typeof value !== 'string') { malformed(`${label} ${name} must be a string`); return ''; }
      return value.trim();
    };
    const flag = (name: string): boolean => {
      const value = row[name];
      if (value !== undefined && typeof value !== 'boolean') malformed(`${label} ${name} must be true or false`);
      return value === true;
    };
    const list = (name: string): readonly unknown[] => {
      const value = row[name] ?? [];
      if (!Array.isArray(value)) { malformed(`${label} ${name} must be a list`); return []; }
      return value;
    };
    for (const name of ['references', 'notes']) list(name);
    const covers = list('covers').map((value) => {
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      malformed(`${label} covers holds ${JSON.stringify(value)}, not a requirement id`);
      return '';
    }).filter((id) => id !== '');
    const after = list('after').map((value) => {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return { bare: true, ref: String(value) };
      if (typeof value === 'string' && value.trim() !== '') return { bare: false, ref: value.trim() };
      malformed(`${label} after holds ${JSON.stringify(value)}; use a sibling's bare id or a quoted reference`);
      return null;
    }).filter((value) => value !== null);
    const risk = row['risk'];
    if (risk !== undefined && !['low', 'medium', 'high'].includes(risk as string)) malformed(`${label} risk must be low, medium or high`);
    return {
      key: key ?? '', type: type as EntryType, title: typeof title === 'string' ? title.trim() : '',
      description: textField('description'), verify: textField('verify'), unknown: textField('unknown'),
      hitl: flag('hitl'), checkpoints: [...(flag('plan_checkpoint') ? ['plan' as const] : []), ...(flag('done_checkpoint') ? ['done' as const] : [])],
      refine: flag('refine'), covers, rawAfter: after,
    };
  });
  const keys = parsed.map((entry) => entry.key);
  for (const key of new Set(keys.filter((key, index) => key !== '' && keys.indexOf(key) !== index))) malformed(`${BREAKDOWN_FILE} has two entries with id ${key}`);
  if (problems.length > 0) return done();
  // A bare number is always a sibling's id; a quoted id is a sibling only
  // when it has a letter and a sibling has it (BMAD). Anything else is
  // outside this breakdown.
  const siblings = new Set(keys);
  const resolved = parsed.map((entry) => {
    const after: string[] = [];
    const external: string[] = [];
    for (const { bare, ref } of entry.rawAfter) {
      if (bare) {
        if (siblings.has(ref)) after.push(ref);
        else problems.push({ code: 'intake_breakdown_prerequisite', detail: `${BREAKDOWN_FILE} entry ${entry.key} is after ${ref}, which names no entry in this breakdown` });
      } else if (/[A-Za-z]/u.test(ref) && siblings.has(ref)) after.push(ref);
      else external.push(ref);
    }
    return { ...entry, after: [...new Set(after)], external: [...new Set(external)] };
  });
  const loop = cycle(resolved);
  if (loop !== null) problems.push({ code: 'intake_breakdown_cycle', detail: `${BREAKDOWN_FILE} entries wait on each other in a cycle: ${loop}` });
  if (problems.length > 0) return done();
  // Exact table spans: each `[[entry]]` header to its last content line. A
  // span that does not re-parse to the same entry is a named problem, never
  // a guessed trace.
  const all = lines(text);
  const headers = all.flatMap((line, index) => ENTRY_HEADER.test(line.text) ? [index] : []);
  const spans = headers.map((first, position) => {
    let last = first;
    for (let index = first + 1; index < all.length; index++) {
      const line = all[index]!.text;
      const header = TABLE_HEADER.exec(line);
      if (header !== null && (ENTRY_HEADER.test(line) || !header[1]!.replace(/["'\s]/gu, '').startsWith('entry.'))) break;
      if (line.trim() !== '' && !/^[ \t]*#/u.test(line)) last = index;
    }
    return { start: all[first]!.start, end: all[last]!.end, position };
  });
  const exact = spans.length === rows.length && spans.every(({ start, end, position }) => {
    try {
      const alone = parse(text.slice(start, end).replace(/^\uFEFF/u, '')) as Record<string, unknown>;
      return Array.isArray(alone['entry']) && alone['entry'].length === 1 && Object.keys(alone).length === 1 && canonical(alone['entry'][0]) === canonical(rows[position]);
    } catch { return false; }
  });
  if (!exact) {
    malformed(`${BREAKDOWN_FILE}: each [[entry]] table must start at its own [[entry]] header line so its exact span can be traced; move other tables and multi-line text out of the entry tables`);
    return done();
  }
  return done(resolved.map(({ refine: _refine, rawAfter: _rawAfter, ...entry }, index) => ({ ...entry, span: { start: spans[index]!.start, end: spans[index]!.end } })));
}

function trace(snapshot: Snapshot, start: number, end: number): Trace {
  return { snapshotId: snapshot.id, start, end, quote: snapshot.text.slice(start, end) };
}
/** Lines under a Markdown "Requirements" heading: covered by an entry or
 * left as open questions, never filed as context. */
function requirementSectionIds(capture: Capture, documents: readonly Snapshot[]): ReadonlySet<string> {
  const ranges = documents.flatMap((snapshot) => {
    const result: { readonly id: string; readonly start: number; readonly end: number }[] = [];
    let open: { readonly level: number; readonly start: number } | null = null;
    let fence: string | null = null;
    for (const line of lines(snapshot.text)) {
      // A `#` line inside fenced code is not a heading.
      const marker = /^[ ]{0,3}(`{3,}|~{3,})/u.exec(line.text)?.[1] ?? null;
      if (marker !== null && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) { fence = fence === null ? marker : null; continue; }
      if (fence !== null) continue;
      const heading = /^(#{1,6})[ \t]/u.exec(line.text);
      if (open !== null && heading !== null && heading[1]!.length <= open.level) { result.push({ id: snapshot.id, start: open.start, end: line.start }); open = null; }
      const requirements = REQUIREMENTS_HEADING.exec(line.text);
      if (open === null && requirements !== null) open = { level: requirements[1]!.length, start: line.end };
    }
    if (open !== null) result.push({ id: snapshot.id, start: open.start, end: snapshot.text.length });
    return result;
  });
  return new Set(capture.requirements.filter(({ trace }) => ranges.some((range) => range.id === trace.snapshotId && trace.start >= range.start && trace.end <= range.end)).map(({ id }) => id));
}
/** One trace per consecutive run of selected inventory lines. */
function runs(capture: Capture, selected: ReadonlySet<string>): Trace[] {
  const snapshots = new Map(capture.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const result: Trace[] = [];
  let current: { snapshot: Snapshot; start: number; end: number } | null = null;
  for (const requirement of capture.requirements) {
    const chosen = selected.has(requirement.id);
    if (current !== null && (!chosen || current.snapshot.id !== requirement.trace.snapshotId)) { result.push(trace(current.snapshot, current.start, current.end)); current = null; }
    if (!chosen) continue;
    if (current === null) current = { snapshot: snapshots.get(requirement.trace.snapshotId)!, start: requirement.trace.start, end: requirement.trace.end };
    else current.end = requirement.trace.end;
  }
  if (current !== null) result.push(trace(current.snapshot, current.start, current.end));
  return result;
}
function unique<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => { const id = key(item); if (seen.has(id)) return false; seen.add(id); return true; });
}
const heistId = (key: string): string => `entry-${key}`;

/** The one mapping from breakdown entries to heists, shared by the v7
 * `tickets.toml` source and the planning minion's slicing output. */
function toPlan(entries: readonly BreakdownEntry[], context: ReadonlySet<string>, questions: readonly string[], capture: Capture, origin: 'tickets' | 'slicing'): Plan {
  const architecture = capture.snapshots.filter(isArchitectureSnapshot);
  const documents = epicDocuments(capture);
  const requirementLines = requirementSectionIds(capture, documents);
  const architectureIds = new Set(capture.requirements.filter(({ trace }) => architecture.some(({ id }) => id === trace.snapshotId)).map(({ id }) => id));
  const contextIds = new Set(capture.requirements.filter(({ id }) => context.has(id) && !requirementLines.has(id) && !architectureIds.has(id)).map(({ id }) => id));
  const shared: Acceptance[] = [
    ...(contextIds.size === 0 ? [] : [{ text: CONTEXT_TEXT, traces: runs(capture, contextIds), clarification: true, requirementIds: [...contextIds] }]),
    ...(architectureIds.size === 0 ? [] : [{
      text: `Binding architecture for every entry, mapped here once: build within ${architecture.map(({ locator }) => locator).join(', ')}. A conflict between it and an entry, the epic or the code is a question for the owner, never a silent choice.`,
      traces: runs(capture, architectureIds), clarification: true, requirementIds: [...architectureIds],
    }]),
  ];
  // Recorded source conflicts stay open: on the entries whose covers the
  // line names, else on the whole plan.
  const conflicts = capture.requirements.filter(({ id, trace }) => !architectureIds.has(id) && documents.some((doc) => doc.id === trace.snapshotId) && SOURCE_CONFLICT.test(trace.quote));
  const conflictQuestion = (quote: string): string => `Settle the recorded source conflict before admitting it: ${quote.trim()}`;
  const names = (quote: string, entry: BreakdownEntry): boolean => entry.coverIds.some((id) => new RegExp(`(?<![0-9A-Za-z])${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![0-9A-Za-z])`, 'u').test(quote));
  const unowned = conflicts.filter(({ trace }) => !entries.some((entry) => names(trace.quote, entry)));
  const heists = entries.map((entry, position): Heist => {
    const covered = unique(entry.covered, ({ id }) => id);
    const own = [...(entry.table === null ? [] : [entry.table.trace]), ...covered.map(({ trace }) => trace)];
    // No captured line supports an untraced entry; only an explicit
    // clarification may stand without one (validatePlan refuses the rest).
    const proposed = own.length === 0 && entry.clarification;
    const said = (text: string): Statement => ({ text, traces: own, clarification: proposed });
    const asked = (text: string): Statement => ({ text, traces: own, clarification: true });
    const label = `Entry ${entry.key}`;
    const others = entries.filter((other) => other !== entry).map(({ key }) => heistId(key));
    return {
      id: heistId(entry.key), title: entry.title,
      goal: entry.description !== '' ? said(entry.description) : asked(`Clarify what entry ${entry.key} delivers; the breakdown gives no description.`),
      scope: [said(`${entry.type[0]!.toUpperCase()}${entry.type.slice(1)}: ${entry.title}`), ...covered.map(({ trace }) => ({ text: trace.quote.trim(), traces: [trace], clarification: false }))],
      exclusions: [{ text: others.length === 0 ? 'Nothing outside this entry is in scope.' : `The other entries of this breakdown (${others.join(', ')}) are separate heists; nothing outside this entry is in scope.`, traces: [], clarification: true }],
      acceptance: [
        { ...(entry.verify !== '' ? said(entry.verify) : asked(`Clarify how entry ${entry.key} is checked; the breakdown gives no verify.`)), requirementIds: [...(entry.table?.requirementIds ?? []), ...covered.map(({ id }) => id)] },
        ...(position === 0 ? shared : []),
      ],
      verification: [entry.verify !== '' ? said(`Show this check passing, with the tests that prove it: ${entry.verify}`) : asked(`Clarify a runnable check for entry ${entry.key}.`)],
      milestones: ['delivered', 'merged'],
      // A dependent slice builds on the prerequisite's merged code.
      dependencies: entry.after.map((key) => ({ id: heistId(key), milestone: 'merged' as const, text: `Needs entry ${key} merged first.`, traces: entry.table === null ? [] : [entry.table.trace], clarification: entry.table === null })),
      unresolvedQuestions: [
        ...(entry.hitl ? [`${label} has a human step (hitl): a person must act for it. Say who does it, or drop the step, before admitting this heist.`] : []),
        ...(entry.unknown !== '' ? [`${label} has an unknown to settle before it starts: ${entry.unknown}`] : []),
        ...(entry.type === 'spike' ? [`${label} is a spike: its result is an answer, not shipped code. Settle it, or confirm it runs as a pull-request heist, before admitting it.`] : []),
        ...entry.checkpoints.map((kind) => `${label} asks for a ${kind} checkpoint (a person ${kind === 'plan' ? 'reviews the plan before work starts' : 'says continue after it'}); GC has no such pause. Confirm the owner's PR review and merge cover it before admitting this heist.`),
        ...entry.external.map((ref) => `${label} is after ${JSON.stringify(ref)}, outside this breakdown; GC cannot see that work. Confirm it is done, or drop the prerequisite, before admitting this heist.`),
        ...entry.missing.map((id) => `${label} covers ${JSON.stringify(id)}, but no captured epic line starts with that id. Correct covers, or supply the epic that defines it.`),
        ...(entry.description === '' ? [`${label} has no description.`] : []),
        ...(entry.verify === '' ? [`${label} has no verify check.`] : []),
        ...conflicts.filter(({ trace }) => names(trace.quote, entry)).map(({ trace }) => conflictQuestion(trace.quote)),
      ],
      splitMergeRationale: origin === 'tickets'
        ? { text: `One heist per entry of the captured ${BREAKDOWN_FILE}, in its table order; its slicing is kept as written.`, traces: own, clarification: false }
        : asked(`${entry.lane === '' ? '' : `Lane ${entry.lane}. `}${entry.rationale === '' ? 'One implementation step toward the epic, sized for one minion session.' : entry.rationale}`),
    };
  });
  const mapped = new Set(heists.flatMap(({ acceptance }) => acceptance.flatMap(({ requirementIds }) => requirementIds)));
  const locators = new Map(capture.snapshots.map((snapshot) => [snapshot.id, snapshot.locator]));
  const unmapped = capture.requirements.filter(({ id }) => !mapped.has(id)).map(({ id, trace }) => ({
    requirementId: id,
    question: `${locators.get(trace.snapshotId)}: ${JSON.stringify(trace.quote.trim())} is ${requirementLines.has(id) ? 'a requirement no entry covers' : 'in no entry and not context'}. Place it in an entry, or confirm it is out of scope.`,
  }));
  return { heists, unmapped, questions: [...questions, ...unowned.map(({ trace }) => conflictQuestion(trace.quote))] };
}

/** The epic's own documents: every captured snapshot except a breakdown and
 * architecture, which are mapped separately. */
function epicDocuments(capture: Capture): readonly Snapshot[] {
  return capture.snapshots.filter((snapshot) => !(snapshot.kind === 'bmad' && isBreakdownLocator(snapshot.locator)) && !isArchitectureSnapshot(snapshot));
}

/** Covers ids name the epic's requirement lines: a line starting with the id
 * (after an optional list marker or emphasis), inside a Requirements section
 * when the documents have one. */
function coveredLines(capture: Capture, ids: readonly string[]): { readonly coverIds: readonly string[]; readonly covered: readonly Requirement[]; readonly missing: readonly string[] } {
  const documents = epicDocuments(capture);
  const ids_ = new Set(documents.map(({ id }) => id));
  const section = requirementSectionIds(capture, documents);
  const pool = capture.requirements.filter(({ id, trace }) => ids_.has(trace.snapshotId) && (section.size === 0 || section.has(id)));
  const covered: Requirement[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const defines = new RegExp(`^\\uFEFF?[ \\t]*(?:#{1,6}[ \\t]+)?(?:[-*+][ \\t]+|\\d+[.)][ \\t]+)?(?:\\*\\*|__)?\\[?${escaped}(?![0-9A-Za-z])`, 'u');
    const found = pool.filter(({ trace }) => defines.test(trace.quote));
    if (found.length === 0) missing.push(id);
    covered.push(...found);
  }
  return { coverIds: ids, covered, missing };
}

/** Default mapping of a captured v7 breakdown: one heist per entry, in table
 * order. Null when the capture has no single valid breakdown. */
export function breakdownPlan(capture: Capture): Plan | null {
  const tables = capture.snapshots.filter(({ kind, locator }) => kind === 'bmad' && isBreakdownLocator(locator));
  if (tables.length !== 1) return null;
  const table = tables[0]!;
  const parsed = parseBreakdown(table.text);
  if (parsed.problems.length > 0) return null;
  const spans = parsed.entries.map(({ span }) => span);
  const inTable = (requirement: Requirement, span: { readonly start: number; readonly end: number }): boolean =>
    requirement.trace.snapshotId === table.id && requirement.trace.start >= span.start && requirement.trace.end <= span.end;
  const entries = parsed.entries.map(({ covers, span, ...entry }): BreakdownEntry => ({
    ...entry, ...coveredLines(capture, covers),
    table: { trace: trace(table, span.start, span.end), requirementIds: capture.requirements.filter((requirement) => inTable(requirement, span)).map(({ id }) => id) },
    clarification: false, lane: '', rationale: '',
  }));
  // Everything outside the entry tables frames the epic: the documents and
  // the breakdown's own comments and settings.
  const context = new Set(capture.requirements.filter((requirement) => requirement.trace.snapshotId !== table.id || !spans.some((span) => inTable(requirement, span))).map(({ id }) => id));
  return toPlan(entries, context, [], capture, 'tickets');
}

function invalid(message: string): never { throw new IntakeError('intake_invalid_plan', message); }
function fields(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter((key) => !keys.includes(key));
  if (extra.length > 0) invalid(`${label} has unsupported fields ${extra.join(', ')}; statuses and approvals are not intake authority`);
  return raw;
}
function words(value: unknown, label: string, optional = false): string {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096 || value.includes('\0')) invalid(`${label} must be nonempty text of at most 4096 characters`);
  return value.trim();
}
function items(value: unknown, label: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4000) invalid(`${label} must be an array of at most 4000 elements`);
  return value;
}

/** A planning minion's slicing output (the GC slicing helper's contract):
 * entries name inventory requirement ids, never offsets, and map to heists
 * through the same mapping as a v7 breakdown. */
export function slicingPlan(value: unknown, capture: Capture): Plan {
  const raw = fields(value, 'breakdown', ['entries', 'context', 'questions']);
  const requirements = new Map(capture.requirements.map((requirement) => [requirement.id, requirement]));
  const known = (id: unknown, label: string): string => {
    if (typeof id !== 'string' || !requirements.has(id)) invalid(`${label} ${JSON.stringify(id)} is not a requirement id of the captured proposal`);
    return id;
  };
  const listed = items(raw['entries'], 'breakdown.entries');
  if (listed.length === 0) invalid('breakdown.entries must list at least one entry');
  const drafts = listed.map((value, index) => {
    const entry = fields(value, `breakdown.entries[${index}]`, ['id', 'type', 'title', 'description', 'verify', 'covers', 'after', 'hitl', 'unknown', 'risk', 'lane', 'rationale', 'clarification']);
    const key = typeof entry['id'] === 'number' && Number.isSafeInteger(entry['id']) && entry['id'] >= 0 ? String(entry['id']) : entry['id'];
    if (typeof key !== 'string' || !ENTRY_ID.test(key)) invalid(`breakdown.entries[${index}].id must be letters and digits`);
    const label = `breakdown entry ${key}`;
    const type = entry['type'] ?? 'story';
    if (!ENTRY_TYPES.includes(type as EntryType)) invalid(`${label} type must be one of ${ENTRY_TYPES.join(', ')}`);
    for (const flag of ['hitl', 'clarification']) if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') invalid(`${label} ${flag} must be true or false`);
    if (entry['risk'] !== undefined && !['low', 'medium', 'high'].includes(entry['risk'] as string)) invalid(`${label} risk must be low, medium or high`);
    const covers = items(entry['covers'], `${label} covers`).map((id) => known(id, `${label} covers`));
    if (new Set(covers).size !== covers.length) invalid(`${label} covers repeats a requirement id`);
    return {
      key, type: type as EntryType, title: words(entry['title'], `${label} title`), description: words(entry['description'], `${label} description`),
      verify: words(entry['verify'], `${label} verify`), unknown: words(entry['unknown'], `${label} unknown`, true), hitl: entry['hitl'] === true,
      after: items(entry['after'], `${label} after`).map((ref) => typeof ref === 'number' ? String(ref) : ref),
      coverIds: covers, covered: covers.map((id) => requirements.get(id)!), clarification: entry['clarification'] === true,
      lane: words(entry['lane'], `${label} lane`, true), rationale: words(entry['rationale'], `${label} rationale`, true),
    };
  });
  const keys = new Set(drafts.map(({ key }) => key));
  if (keys.size !== drafts.length) invalid('breakdown entry ids must be unique');
  for (const draft of drafts) {
    for (const ref of draft.after) if (typeof ref !== 'string' || !keys.has(ref)) invalid(`breakdown entry ${draft.key} is after ${JSON.stringify(ref)}, which names no entry of this breakdown`);
  }
  const entries = drafts.map((draft): BreakdownEntry => ({ ...draft, after: [...new Set(draft.after as string[])], external: [], checkpoints: [], table: null, missing: [] }));
  const loop = cycle(entries);
  if (loop !== null) invalid(`breakdown entries wait on each other in a cycle: ${loop}`);
  const context = new Set(items(raw['context'], 'breakdown.context').map((id) => known(id, 'breakdown.context')));
  const questions = items(raw['questions'], 'breakdown.questions').map((question) => words(question, 'breakdown.questions'));
  return toPlan(entries, context, questions, capture, 'slicing');
}
