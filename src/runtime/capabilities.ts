import type { AgentCapabilities } from './types.js';

/**
 * Static adapter capability declarations (SPEC ruling 4: gaps declared,
 * never silent).
 *
 * These live in their own dependency-light module so the runtime probe can
 * report capabilities WITHOUT importing the adapter modules: both adapters
 * import the agent SDK graphs at module scope, and a wizard/probe process
 * must not pay that cost (measured: importing `runtime/probe.js` while it
 * re-imported the adapters took ~7s of the setup wizard's startup, making
 * even a documented `--answers` validation refusal wait on SDK loading).
 * The adapters re-export these same objects, so every existing import
 * surface keeps identical values and identity.
 */

/** claude-code adapter capabilities, hoisted for the runtime probe
 * (E3 story 3). */
export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  // The -p surface has no mid-turn channel (that lives in the SDK control
  // protocol, out of scope per SPEC ruling 4) — the interface layer queues.
  steer: 'queued',
  resume: 'file',
  images: true,
  thinking: true,
  thinkingLevelControl: true, // via --effort
  followUp: false,
};

/** pi adapter capabilities, hoisted so the runtime probe can report them
 * without constructing the adapter (E3 story 3). */
export const PI_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  // Adapter transport support. A spawned handle overrides this from the
  // resolved model's declared input modalities (B1).
  images: true,
  thinking: true,
  thinkingLevelControl: true,
  followUp: true,
};
