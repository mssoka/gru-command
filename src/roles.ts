import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from './config.js';

/**
 * Product-native role definitions (SPEC ruling 15): roles are prompt +
 * tool set + skills + cwd policy, runtime-agnostic. Every persona lives
 * in `roles/<role>.md` — the file is the source of truth, loaded here at
 * module load (fail-loud when missing or empty: the product ships all
 * five, and a session without its persona is a session we refuse to
 * host).
 */

export interface RoleDefinition {
  readonly role: Role;
  /** System prompt for sessions hosted under this role. */
  readonly systemPrompt: string;
  /** Built-in tool names enabled for this role (pi tool ids; adapters map). */
  readonly tools: readonly string[];
  /**
   * Skill names the role is trained on (runtime-agnostic ids). They are
   * NOT injected by this service — skills resolve from the PROJECT's own
   * skills/bmad folders at spawn (SPEC ruling 17: project knowledge
   * travels with the project, discovered from the session cwd).
   */
  readonly skills: readonly string[];
  /**
   * Working-directory policy (SPEC ruling 17): 'workspace_root' hosts at
   * the workspace root (the chat Gru, ops, memory); 'spawn_provided'
   * REQUIRES an explicit cwd per spawn — the dispatch flow roots the
   * role in the project worktree it serves.
   */
  readonly cwd: 'workspace_root' | 'spawn_provided';
}

/** `<package>/roles/` — src/ and dist/ both sit one level below the
 * package root, so one relative path serves dev and built layouts. */
const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'roles');

const ROLE_PROMPT_FILES: Readonly<Record<Role, string>> = {
  gru: 'gru.md',
  silas: 'silas.md',
  minion: 'minion.md',
  perkins: 'perkins.md',
  bob: 'bob.md',
};

function loadRoleSystemPrompt(role: Role): string {
  const file = join(ROLES_DIR, ROLE_PROMPT_FILES[role]);
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (error) {
    throw new Error(
      `${role} role prompt ${file} is unreadable (${String(error)}); ` +
        'the product ships one prompt file per role — restore it before hosting sessions',
    );
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new Error(`${role} role prompt ${file} is empty — the role needs its persona`);
  }
  return trimmed;
}

export const ROLE_DEFINITIONS: Readonly<Record<Role, RoleDefinition>> = {
  gru: {
    role: 'gru',
    systemPrompt: loadRoleSystemPrompt('gru'),
    tools: ['read', 'bash', 'grep', 'find', 'ls'],
    skills: [],
    cwd: 'workspace_root',
  },
  silas: {
    role: 'silas',
    systemPrompt: loadRoleSystemPrompt('silas'),
    tools: ['read', 'bash', 'grep', 'find', 'ls'],
    skills: ['ops-dispatch', 'ledger-closeout'],
    cwd: 'workspace_root',
  },
  minion: {
    role: 'minion',
    systemPrompt: loadRoleSystemPrompt('minion'),
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    skills: ['build-verify', 'worktree-hygiene'],
    cwd: 'spawn_provided',
  },
  perkins: {
    role: 'perkins',
    systemPrompt: loadRoleSystemPrompt('perkins'),
    tools: ['read', 'grep', 'find', 'ls'],
    skills: ['lens-blind', 'lens-edge', 'lens-acceptance', 'lens-security', 'lens-architecture', 'lens-codebase', 'lens-tests'],
    cwd: 'spawn_provided',
  },
  bob: {
    role: 'bob',
    systemPrompt: loadRoleSystemPrompt('bob'),
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    skills: ['memory-consolidation'],
    cwd: 'workspace_root',
  },
};

/**
 * SPEC ruling 17 guard: a 'spawn_provided' role without an explicit cwd
 * is a dispatch bug (the agent would silently land at the workspace root
 * and lose the project's skills/bmad discovery). Fail loud at the call
 * site instead. Returns the cwd for chaining.
 */
export function requireSpawnCwd(role: Role, cwd: string | undefined): string {
  if (ROLE_DEFINITIONS[role].cwd !== 'spawn_provided') return cwd ?? '';
  if (cwd === undefined || cwd === '') {
    throw new Error(
      `role "${role}" requires an explicit spawn cwd (the project worktree it serves) — ` +
        'refusing to host it at the workspace root (SPEC ruling 17)',
    );
  }
  return cwd;
}
