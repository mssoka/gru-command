import { loadSkillsFromDir, type Skill } from '@earendil-works/pi-coding-agent';
import type { RuntimeId } from '../config.js';
import type { ManagedSkillSet } from './types.js';

/** Thrown when a bound runtime does not yield the skills it declares. */
export class ManagedSkillsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedSkillsError';
  }
}

/** The system-prompt section naming the bound runtime for the session. */
export function managedSkillsPromptNote(managed: ManagedSkillSet, runtime: RuntimeId): string {
  const names = runtime === 'claude-code'
    ? managed.skills.map((skill) => `\`${managed.source}:${skill}\``)
    : managed.skills.map((skill) => `\`${skill}\``);
  return [
    '## Gru Command BMAD runtime',
    '',
    `This session is bound to the Gru Command-managed BMAD runtime \`${managed.runtimeId}\` ` +
      `(content sha256 \`${managed.contentSha256.slice(0, 16)}\`), installed at \`${managed.root}\` ` +
      '(read-only files, verified against that hash whenever a session starts). ' +
      (managed.laneBound
        ? 'The binding is recorded for this job lane and does not change when Gru Command is updated. '
        : '') +
      `It supplies ${names.join(', ')}. ` +
      (runtime === 'claude-code'
        ? 'Use those entries, not a repo-local or global skill with the same base name.'
        : 'They take precedence over any repo-local or global skill with the same name.'),
    'Keep project configuration and generated work in this repository: settings in `_bmad/custom/`, ' +
      'outputs where that configuration points (`_bmad-output/` by default). Never modify the runtime directory.',
  ].join('\n');
}

/**
 * pi `skillsOverride`: the bound runtime's skills first, then the session's
 * own catalog minus any same-named entry (pi keeps the FIRST skill of a name,
 * so a repo-local copy would otherwise shadow the bound runtime).
 */
export function preferManagedSkills<D extends { readonly type: string; readonly collision?: { readonly name: string } }>(
  base: { skills: Skill[]; diagnostics: D[] },
  managed: ManagedSkillSet,
): { skills: Skill[]; diagnostics: D[] } {
  const loaded = loadSkillsFromDir({ dir: managed.skillsDir, source: managed.source });
  const names = new Set(managed.skills);
  const supplied = loaded.skills.filter((skill) => names.has(skill.name));
  const missing = managed.skills.filter((name) => !supplied.some((skill) => skill.name === name));
  if (missing.length > 0) {
    throw new ManagedSkillsError(
      `BMAD runtime ${managed.runtimeId} at ${managed.root} did not load declared skill(s): ${missing.join(', ')}`,
    );
  }
  return {
    skills: [...supplied, ...base.skills.filter((skill) => !names.has(skill.name))],
    diagnostics: base.diagnostics.filter(
      (diagnostic) => !(diagnostic.type === 'collision' && diagnostic.collision !== undefined && names.has(diagnostic.collision.name)),
    ),
  };
}
