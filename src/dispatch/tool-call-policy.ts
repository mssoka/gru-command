/**
 * The no-call-budget contract (issue #158): minion work is halted,
 * re-briefed, or held noncompliant solely because it crossed an arbitrary
 * tool-call count — not because it stalled, failed, or misbehaved. The cap
 * lived in briefing-generation and operations practice, never in shipped
 * enforcement, so nothing stopped a coordinator from reinventing the same
 * ceiling and treating it as a real gate.
 *
 * The block below makes the shipped contract explicit and travels with
 * every assembled worker instruction (initial briefing, follow-up
 * directives, re-brief prompts): a numeric total or per-phase tool-call
 * ceiling is non-binding telemetry, never an acceptance/compliance gate,
 * while the real controls (owner cancellation and authorized spend,
 * provider limits, permissions, concurrency and verification budgets,
 * genuine non-progress stalls, review/test gates) stay untouched.
 *
 * Like the new-PR rule, this is an instruction contract carried by
 * generated prompts — it is NOT a sandbox over a model's own reasoning.
 */

/** The no-call-budget rule block carried by every worker instruction. */
export const TOOL_CALL_POLICY = [
  'Tool-call policy (current — supersedes any numeric tool-call ceiling in this',
  'or an older contract; this rule grants no extra spend, time, or safety',
  'permission): no total or per-phase tool-call budget binds this task or its',
  'implementation-review cycle. A tool-call count is informational telemetry,',
  'never a gate: crossing any number cannot by itself block acceptance, tests,',
  'review, or publication, force a source hand-back, quarantine the worker,',
  'demand coordinator budget approval, or manufacture a noncompliance verdict.',
  'If a briefing or directive names a numeric call ceiling, it does not bind —',
  'keep working until the task is genuinely done and verified, and name the',
  'discrepancy in the completion report instead of stopping for the number.',
  'Do not substitute a turn or elapsed-time cap. Real gates are unchanged:',
  'owner cancellation and explicitly authorized spend limits, provider rate',
  'limits, permission/tool confinement, concurrency and resource limits,',
  'genuine non-progress stalls (silence with no live process), verification',
  'budgets owned by the verify scheduler, and required review/test gates.',
].join('\n');
