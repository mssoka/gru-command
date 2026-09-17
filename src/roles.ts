import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from './config.js';

/**
 * Product-native role definitions (SPEC ruling 15): roles are prompt +
 * tool set + cwd, runtime-agnostic. The Gru persona — the role users
 * actually talk to — lives in `roles/gru.md` (E4): the file is the
 * source of truth, loaded here at module load (fail-loud when missing).
 * Full personas, skill mappings, and permissions for the remaining roles
 * arrive with E8; these are the minimal definitions the runtime layer
 * needs to host a session per role.
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

/** `<package>/roles/gru.md` — src/ and dist/ both sit one level below the
 * package root, so one relative path serves dev and built layouts. */
const GRU_PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'roles', 'gru.md');

function loadGruSystemPrompt(): string {
  let text: string;
  try {
    text = readFileSync(GRU_PROMPT_FILE, 'utf-8');
  } catch (error) {
    throw new Error(
      `gru role prompt ${GRU_PROMPT_FILE} is unreadable (${String(error)}); ` +
        'the product ships roles/gru.md — restore it before hosting a gru session',
    );
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new Error(`gru role prompt ${GRU_PROMPT_FILE} is empty — the role needs its persona`);
  }
  return trimmed;
}

const PRODUCT_CONTEXT = [
  'You are an agent hosted by a standalone multi-agent orchestrator service.',
  'The service exposes a web front-end; the browser is the only required window.',
  'Keep answers operational and precise; artifacts you produce stay plain and factual.',
].join(' ');

export const ROLE_DEFINITIONS: Readonly<Record<Role, RoleDefinition>> = {
  gru: {
    role: 'gru',
    systemPrompt: loadGruSystemPrompt(),
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
