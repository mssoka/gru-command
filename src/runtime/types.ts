import type { Role } from '../config.js';

/**
 * Runtime adapter interface (EPICS E2 story 1; SPEC ruling 4).
 *
 * Everything above the adapter layer consumes THIS module only — never a
 * concrete adapter import. A runtime hosts agent sessions; a handle is one
 * live agent session (one session file, one single-writer queue).
 */

/** Adapter-level capability declaration (SPEC ruling 4: gaps declared, never silent). */
export interface AgentCapabilities {
  /** Streaming message deltas (text/thinking) are emitted as they arrive. */
  readonly streaming: boolean;
  /**
   * Steering support: 'native' = mid-turn interruption is delivered to the
   * live turn; 'queued' = the runtime cannot steer mid-turn — the interface
   * layer queues the text until idle (see fallbacks.ts).
   */
  readonly steer: 'native' | 'queued';
  /** Session persistence across process restarts ('file' = durable jsonl). */
  readonly resume: 'file' | 'none';
  /** The runtime accepts image content in prompts. */
  readonly images: boolean;
  /** Thinking/reasoning output is surfaced. */
  readonly thinking: boolean;
  /**
   * The adapter can SET the thinking level per spawn. When false, a
   * non-default thinkingLevel request degrades to warn + proceed
   * (SPEC ruling 16 capability-gap fallback).
   */
  readonly thinkingLevelControl: boolean;
  /** followUp (queue-until-idle from the SAME owner) is supported natively. */
  readonly followUp: boolean;
}

/** Lifecycle state of an agent session, mirrored into /health liveness. */
export type AgentState = 'spawning' | 'idle' | 'streaming' | 'error' | 'disposed';

const AGENT_STATES: readonly AgentState[] = ['spawning', 'idle', 'streaming', 'error', 'disposed'];

/** Runtime guard for write surfaces (the ledger records what adapters emit). */
export function isAgentState(value: string): value is AgentState {
  return (AGENT_STATES as readonly string[]).includes(value);
}

export interface AgentHealth {
  readonly state: AgentState;
  /** ISO timestamp of the last observed event; null when nothing happened yet. */
  readonly lastActivity: string | null;
  /** Set when state === 'error'. */
  readonly error?: string;
  /** Absolute path of the session jsonl (declared per SPEC ruling 12). */
  readonly sessionFile: string | null;
}

export interface RuntimeHealth {
  /** 'ok' = adapter constructed and able to spawn. */
  readonly state: 'ok' | 'degraded' | 'down';
  readonly note?: string;
}

/** Options for spawn(). */
export interface SpawnOptions {
  /**
   * Resume an existing session file instead of creating a new one.
   * When omitted a fresh session is created.
   */
  readonly resumeFile?: string;
  /**
   * Working directory for the session (SPEC ruling 17): the dispatch
   * flow roots minions and reviewers in the PROJECT they serve. Must be
   * an absolute path to an existing directory; omitted = the workspace
   * root (the chat Gru's home, by design).
   */
  readonly cwd?: string;
  /**
   * Model override: "provider/model", or "default" (or "") for the
   * runtime harness's own configured model (SPEC ruling 16 passthrough).
   */
  readonly model?: string;
  /**
   * Thinking level override; "default" (or "") passes through to the
   * runtime's own setting (SPEC ruling 16 passthrough).
   */
  readonly thinkingLevel?: string;
}

/**
 * Emitted through subscribe(). The typed event surface every consumer
 * (future chat UI, board, supervisor) builds on.
 */
export type RuntimeEvent =
  | { readonly type: 'state'; readonly state: AgentState; readonly error?: string }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'thinking_delta'; readonly delta: string }
  | {
      readonly type: 'tool_start';
      readonly callId: string;
      readonly tool: string;
    }
  | { readonly type: 'tool_update'; readonly callId: string }
  | { readonly type: 'tool_end'; readonly callId: string; readonly isError: boolean }
  | { readonly type: 'turn_start' }
  | { readonly type: 'turn_end' }
  | {
      /** A message was queued because a turn is live (single-writer, SPEC ruling 1). */
      readonly type: 'queued';
      readonly reason: 'single-writer' | 'steer-unable';
      readonly owner: string;
    }
  | { readonly type: 'error'; readonly error: string; readonly fatal: boolean };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export type PromptOwner = string;

export interface PromptOptions {
  /** Who is asking (single-writer identity). Defaults to the handle's own
   * principal — all unnamed callers of one handle share it; two distinct
   * sessions always attribute differently (SPEC ruling 1). */
  readonly owner?: PromptOwner;
  /** Images attached to the prompt (capability-checked). */
  readonly images?: ReadonlyArray<{ readonly mediaType: string; readonly data: string }>;
  /**
   * Opt-in cap on how long THIS call may wait in a queue-until-idle hold
   * (E2 deferral, E7 home): when the wait exceeds the budget the call
   * REJECTS — only this caller, never the queue or the live turn. The
   * supervision watchdog owns un-hanging the turn itself.
   */
  readonly timeoutMs?: number;
}

/** One live agent session hosted by a runtime. */
export interface AgentHandle {
  readonly role: Role;
  readonly id: string;
  readonly sessionFile: string | null;
  /**
   * Send a prompt and resolve when the resulting turn completes. A prompt
   * from a second owner while a turn is live is QUEUED (single-writer, SPEC
   * ruling 1) and resolves after it is eventually delivered.
   */
  prompt(text: string, options?: PromptOptions): Promise<void>;
  /**
   * Interrupt/redirect the live turn. Native on pi; runtimes declaring
   * steer 'queued' get the fallback wrapper's queue-until-idle behavior.
   */
  steer(text: string, options?: PromptOptions): Promise<void>;
  /** Queue a message for after the current turn completes. */
  followUp(text: string, options?: PromptOptions): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  health(): AgentHealth;
  dispose(): Promise<void>;
}

/** A runtime adapter (pi today; claude-code in E3). */
export interface AgentRuntime {
  readonly id: string;
  readonly capabilities: AgentCapabilities;
  spawn(role: Role, options?: SpawnOptions): Promise<AgentHandle>;
  health(): RuntimeHealth;
  dispose(): Promise<void>;
}
