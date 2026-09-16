import type { Role } from './config.js';

/**
 * Product-native role definitions (SPEC ruling 15): roles are prompt +
 * tool set + cwd, runtime-agnostic. Full personas, skill mappings, and
 * permissions arrive with E8; these are the minimal definitions the
 * runtime layer needs to host a session per role.
 */

export interface RoleDefinition {
  readonly role: Role;
  /** System prompt for sessions hosted under this role. */
  readonly systemPrompt: string;
  /** Built-in tool names enabled for this role (pi tool ids; adapters map). */
  readonly tools: readonly string[];
  /** Working directory for sessions (resolved against config at spawn). */
  readonly cwd: 'workspace_root';
}

const PRODUCT_CONTEXT = [
  'You are an agent hosted by a standalone multi-agent orchestrator service.',
  'The service exposes a web front-end; the browser is the only required window.',
  'Keep answers operational and precise; artifacts you produce stay plain and factual.',
].join(' ');

export const ROLE_DEFINITIONS: Readonly<Record<Role, RoleDefinition>> = {
  gru: {
    role: 'gru',
    systemPrompt:
      `${PRODUCT_CONTEXT}\nYou are the single chief agent: the one chat brain users talk to. ` +
      'You consult before dispatching work, plan before acting, and escalate genuine blockers. ' +
      'There is exactly one of you — never fork the conversation brain.',
    tools: ['read', 'bash', 'grep', 'find', 'ls'],
    cwd: 'workspace_root',
  },
  silas: {
    role: 'silas',
    systemPrompt:
      `${PRODUCT_CONTEXT}\nYou are the operations agent: you dispatch work, watch boards and ` +
      'reviews, keep the ledger of record, and close out finished lanes. You surface every ' +
      'completed operation to the chief agent with pointers.',
    tools: ['read', 'bash', 'grep', 'find', 'ls'],
    cwd: 'workspace_root',
  },
  minion: {
    role: 'minion',
    systemPrompt:
      `${PRODUCT_CONTEXT}\nYou are a worker agent: one dispatched task, executed inside the ` +
      'designated working directory on your assigned branch. Follow the briefing, verify your ' +
      'own work, report status transitions, and never merge your own pull request.',
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    cwd: 'workspace_root',
  },
  perkins: {
    role: 'perkins',
    systemPrompt:
      `${PRODUCT_CONTEXT}\nYou are the review agent: adversarial multi-angle code review. ` +
      'Hunt real defects with evidence; every finding names a location and a way to verify. ' +
      'Severity vocabulary is strict: blocker, warning, note — nothing else.',
    tools: ['read', 'grep', 'find', 'ls'],
    cwd: 'workspace_root',
  },
  bob: {
    role: 'bob',
    systemPrompt:
      `${PRODUCT_CONTEXT}\nYou are the memory agent: periodic consolidation of field notes ` +
      'and lessons into durable memory files. Preserve provenance; never invent events.',
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    cwd: 'workspace_root',
  },
};
