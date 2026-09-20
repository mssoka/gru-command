import { StringDecoder } from 'node:string_decoder';
import type { RuntimeEvent } from './types.js';

/**
 * stream-json (NDJSON) layer for the claude-code adapter (EPICS E3 story 1).
 *
 * Pure and I/O-free so every nasty edge is unit-testable: byte-chunked
 * frames, multi-byte UTF-8 splits, blank/garbage lines, unknown frame types
 * (forward-compat), and the partial-vs-complete dedupe rule.
 *
 * Frame shapes (verified against the CLI reference + headless docs):
 *   system/init      { type:'system', subtype:'init', session_id, cwd, tools, model, ... }
 *   assistant        { type:'assistant', message:{ content: Block[] }, session_id?, parent_tool_use_id? }
 *   user             { type:'user', message:{ content: Block[] | string }, ... }  (tool_result blocks)
 *   stream_event     { type:'stream_event', event: <raw Anthropic SSE>, session_id }  (--include-partial-messages)
 *   result           { type:'result', subtype, is_error, result?, session_id?, ... }  (always last)
 *   rate_limit_event / tool_progress / hook events / api_retry — informational.
 */

/** A parsed frame as a plain record (shape validated by readers, not a schema lib). */
export type StreamFrame = Record<string, unknown>;

export interface NdjsonParserOptions {
  /** Called for every successfully parsed JSON object line. */
  readonly onFrame: (frame: StreamFrame) => void;
  /** Called for every non-blank line that is not valid JSON. */
  readonly onGarbage?: (line: string) => void;
}

/**
 * Incremental NDJSON parser: byte-safe (UTF-8 sequences may split across
 * chunks), line-buffered (a frame may split anywhere), tolerant (blank
 * lines skipped, garbage reported + skipped). A trailing partial line at
 * end() is reported as garbage and dropped — a torn tail must never be
 * parsed as a frame.
 */
export class NdjsonParser {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private mode: 'string' | 'bytes' | null = null;
  private readonly onFrame: (frame: StreamFrame) => void;
  private readonly onGarbage: (line: string) => void;

  constructor(opts: NdjsonParserOptions) {
    this.onFrame = opts.onFrame;
    this.onGarbage = opts.onGarbage ?? (() => {});
  }

  push(chunk: Uint8Array | string): void {
    // Mixed-mode pushes would corrupt ordering (decoder-held bytes flush
    // after directly-appended strings) — forbid them loudly.
    const mode = typeof chunk === 'string' ? 'string' : 'bytes';
    if (this.mode === null) this.mode = mode;
    if (this.mode !== mode) {
      throw new Error('NdjsonParser: do not mix string and byte pushes on one parser');
    }
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line);
    }
  }

  /**
   * Flush at EOF. A non-blank tail that PARSES is a complete frame whose
   * newline was lost to a kill racing the last flush — deliver it. Only an
   * unparseable tail is torn: reported as garbage and dropped.
   */
  end(): void {
    this.buffer += this.decoder.end();
    const tail = this.buffer;
    this.buffer = '';
    if (tail.trim() !== '') this.handleLine(tail);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.onGarbage(trimmed);
      return;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      this.onFrame(parsed as StreamFrame);
    } else {
      this.onGarbage(trimmed);
    }
  }
}

export interface InitInfo {
  readonly sessionId: string;
  readonly model: string | null;
  readonly tools: readonly string[];
  readonly cwd: string | null;
}

export interface ResultInfo {
  readonly subtype: string;
  readonly isError: boolean;
  /** The final result text, when present. */
  readonly text: string | null;
}

/** Machine-frame reader for native Claude controls such as `/compact`.
 * Unlike a turn translator it has no content event surface by design:
 * assistant text/tool frames are consumed as command output and can never
 * escape into chat. */
export class ClaudeControlTranslator {
  private readonly frames = new ClaudeTurnTranslator();
  private compactBoundary = false;
  private compactResult: 'success' | 'failed' | null = null;
  private compactError: string | null = null;

  get init(): InitInfo | null {
    return this.frames.init;
  }

  get result(): ResultInfo | null {
    return this.frames.result;
  }

  /** Native compact succeeded only when Claude reports its compact status or
   * emits the compact boundary. A nominally successful slash-command result
   * alone is insufficient: the command can complete while compaction fails. */
  get compactSucceeded(): boolean {
    return this.compactResult === 'success' || (this.compactResult === null && this.compactBoundary);
  }

  get compactFailure(): string | null {
    return this.compactResult === 'failed'
      ? (this.compactError ?? 'claude reported native compaction failed')
      : null;
  }

  ingest(frame: StreamFrame): void {
    // ClaudeTurnTranslator already carries the pinned init/result validation
    // rules. Deliberately discard every returned content event.
    this.frames.ingest(frame);

    // Claude 2.1.x emits `system/compact_boundary` on success and may also
    // place compact_result/compact_error on its status frame. Accept both
    // documented machine shapes, but never infer success from human text.
    if (
      (frame['type'] === 'system' && frame['subtype'] === 'compact_boundary') ||
      frame['type'] === 'compact_boundary'
    ) {
      this.compactBoundary = true;
    }
    // A compact_result is authoritative only on Claude's machine status
    // frame. Ignore same-named fields on assistant/tool/unknown frames so
    // command content cannot forge a native control outcome.
    if (frame['type'] !== 'system' || frame['subtype'] !== 'status') return;
    const result = frame['compact_result'];
    if (result === 'success' && this.compactResult !== 'failed') {
      this.compactResult = 'success';
      this.compactError = null;
    } else if (result === 'failed' || result === 'failure' || result === 'error') {
      this.compactResult = 'failed';
      this.compactError =
        typeof frame['compact_error'] === 'string' && frame['compact_error'] !== ''
          ? frame['compact_error']
          : null;
    }
  }
}

interface OpenBlock {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
}

/**
 * Translates stream-json frames of ONE turn into interface events.
 * Lifecycle events (state, turn_start/turn_end, errors) are owned by the
 * turn runner in the adapter; this class owns CONTENT events only.
 *
 * Dedupe rule: with --include-partial-messages the CLI emits BOTH
 * stream_event partials AND the complete assistant frame. Per kind, the
 * partials win and the complete blocks are suppressed; a CLI that emits no
 * partials gets its text/thinking/tool_start from the complete frames
 * (each exactly once).
 */
/**
 * Translates stream-json frames of ONE turn into interface events.
 * Lifecycle events (state, turn_start/turn_end, errors) are owned by the
 * turn runner in the adapter; this class owns CONTENT events only.
 *
 * Dedupe rule: with --include-partial-messages the CLI emits BOTH
 * stream_event partials AND the complete assistant frame. Partials win;
 * the complete blocks are suppressed — PER MESSAGE when the partial stream
 * carries message ids (message_start events, the real CLI shape), so a
 * message whose partials never arrived mid-turn is still emitted from its
 * complete frame. When the partial stream carries no message ids at all
 * (older/minimal emitters), suppression falls back to per-kind turn-global
 * flags. Tool calls dedupe precisely by tool_use id either way.
 */
export class ClaudeTurnTranslator {
  private sawTextDelta = false;
  private sawThinkingDelta = false;
  /** message id → content kinds its partials covered (when ids observable). */
  private readonly messageKinds = new Map<string, Set<'text' | 'thinking'>>();
  private currentMessageId: string | null = null;
  private partialsHaveMessageIds = false;
  private readonly announcedTools = new Set<string>();
  private readonly openBlocks = new Map<number, OpenBlock>();
  private initInfo: InitInfo | null = null;
  private resultInfo: ResultInfo | null = null;

  /** The system/init frame's info, once seen. */
  get init(): InitInfo | null {
    return this.initInfo;
  }

  /** The result frame's info, once seen. */
  get result(): ResultInfo | null {
    return this.resultInfo;
  }

  /** Consume one parsed frame; returns the interface events it implies. */
  ingest(frame: StreamFrame): RuntimeEvent[] {
    const type = frame['type'];
    switch (type) {
      case 'system':
        return this.ingestSystem(frame);
      case 'assistant':
        return this.ingestAssistant(frame);
      case 'user':
        return this.ingestUser(frame);
      case 'stream_event':
        return this.ingestStreamEvent(frame);
      case 'result':
        return this.ingestResult(frame);
      case 'tool_progress': {
        // Long-tool heartbeat (informational): surfaces as a tool_update
        // for the in-flight call when it names one.
        const parent = frame['parent_tool_use_id'];
        if (typeof parent === 'string' && parent !== '') {
          return [{ type: 'tool_update', callId: parent }];
        }
        return [];
      }
      default:
        // rate_limit_event, hook events, plugin_install, unknown future
        // types — forward-compat is silent by design.
        return [];
    }
  }

  private ingestSystem(frame: StreamFrame): RuntimeEvent[] {
    if (frame['subtype'] !== 'init') return []; // api_retry, hook events, ...
    const tools = frame['tools'];
    this.initInfo = {
      sessionId: typeof frame['session_id'] === 'string' ? frame['session_id'] : '',
      model: typeof frame['model'] === 'string' ? frame['model'] : null,
      tools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : [],
      cwd: typeof frame['cwd'] === 'string' ? frame['cwd'] : null,
    };
    return [];
  }

  private ingestResult(frame: StreamFrame): RuntimeEvent[] {
    if (this.resultInfo !== null) return []; // exactly one result per turn
    this.resultInfo = {
      subtype: typeof frame['subtype'] === 'string' ? frame['subtype'] : '',
      isError: frame['is_error'] === true,
      text: typeof frame['result'] === 'string' ? frame['result'] : null,
    };
    return [];
  }

  private ingestAssistant(frame: StreamFrame): RuntimeEvent[] {
    const message = frame['message'];
    if (typeof message !== 'object' || message === null) return [];
    const content = (message as StreamFrame)['content'];
    if (!Array.isArray(content)) return [];
    // Dedupe granularity: per message id when partials carry ids, else the
    // turn-global per-kind flags.
    const mid = (message as StreamFrame)['id'];
    const kinds =
      this.partialsHaveMessageIds && typeof mid === 'string'
        ? this.messageKinds.get(mid)
        : undefined;
    const suppressText =
      kinds !== undefined ? kinds.has('text') : this.partialsHaveMessageIds ? false : this.sawTextDelta;
    const suppressThinking =
      kinds !== undefined
        ? kinds.has('thinking')
        : this.partialsHaveMessageIds
          ? false
          : this.sawThinkingDelta;
    const events: RuntimeEvent[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as StreamFrame;
      if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'] !== '') {
        if (!suppressText) events.push({ type: 'text_delta', delta: b['text'] });
      } else if (
        b['type'] === 'thinking' &&
        typeof b['thinking'] === 'string' &&
        b['thinking'] !== ''
      ) {
        if (!suppressThinking) {
          events.push({ type: 'thinking_delta', delta: b['thinking'] });
        }
      } else if (b['type'] === 'tool_use') {
        const id = b['id'];
        const name = b['name'];
        if (typeof id === 'string' && typeof name === 'string' && !this.announcedTools.has(id)) {
          this.announcedTools.add(id);
          events.push({ type: 'tool_start', callId: id, tool: name });
        }
      }
      // image/document echoes and unknown block types: skip silently.
    }
    return events;
  }

  private ingestUser(frame: StreamFrame): RuntimeEvent[] {
    const message = frame['message'];
    if (typeof message !== 'object' || message === null) return [];
    const content = (message as StreamFrame)['content'];
    if (!Array.isArray(content)) return [];
    const events: RuntimeEvent[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as StreamFrame;
      if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
        events.push({
          type: 'tool_end',
          callId: b['tool_use_id'],
          isError: b['is_error'] === true,
        });
      }
    }
    return events;
  }

  /**
   * stream_event wraps a raw Anthropic SSE event: content_block_start /
   * content_block_delta / content_block_stop carry the partials.
   */
  private ingestStreamEvent(frame: StreamFrame): RuntimeEvent[] {
    const event = frame['event'];
    if (typeof event !== 'object' || event === null) return [];
    const e = event as StreamFrame;
    const index = typeof e['index'] === 'number' ? e['index'] : null;
    switch (e['type']) {
      case 'message_start': {
        // The Anthropic SSE envelope: partials for ONE message follow.
        const message = e['message'];
        const id =
          typeof message === 'object' && message !== null
            ? (message as StreamFrame)['id']
            : undefined;
        if (typeof id === 'string' && id !== '') {
          this.partialsHaveMessageIds = true;
          this.currentMessageId = id;
          if (!this.messageKinds.has(id)) this.messageKinds.set(id, new Set());
        }
        return [];
      }
      case 'message_stop':
        this.currentMessageId = null;
        return [];
      case 'content_block_start': {
        const block = e['content_block'];
        if (index === null || typeof block !== 'object' || block === null) return [];
        const b = block as StreamFrame;
        const open: OpenBlock = {
          type: typeof b['type'] === 'string' ? b['type'] : '',
          ...(typeof b['id'] === 'string' ? { id: b['id'] } : {}),
          ...(typeof b['name'] === 'string' ? { name: b['name'] } : {}),
        };
        this.openBlocks.set(index, open);
        if (open.type === 'tool_use' && open.id !== undefined && open.name !== undefined) {
          if (this.announcedTools.has(open.id)) return [];
          this.announcedTools.add(open.id);
          return [{ type: 'tool_start', callId: open.id, tool: open.name }];
        }
        return [];
      }
      case 'content_block_delta': {
        const delta = e['delta'];
        if (typeof delta !== 'object' || delta === null) return [];
        const d = delta as StreamFrame;
        if (d['type'] === 'text_delta' && typeof d['text'] === 'string' && d['text'] !== '') {
          this.sawTextDelta = true;
          if (this.currentMessageId !== null) {
            this.messageKinds.get(this.currentMessageId)?.add('text');
          }
          return [{ type: 'text_delta', delta: d['text'] }];
        }
        if (
          d['type'] === 'thinking_delta' &&
          typeof d['thinking'] === 'string' &&
          d['thinking'] !== ''
        ) {
          this.sawThinkingDelta = true;
          if (this.currentMessageId !== null) {
            this.messageKinds.get(this.currentMessageId)?.add('thinking');
          }
          return [{ type: 'thinking_delta', delta: d['thinking'] }];
        }
        if (d['type'] === 'input_json_delta') {
          if (index === null) return [];
          const open = this.openBlocks.get(index);
          if (open !== undefined && open.type === 'tool_use' && open.id !== undefined) {
            return [{ type: 'tool_update', callId: open.id }];
          }
        }
        return [];
      }
      case 'content_block_stop':
        if (index !== null) this.openBlocks.delete(index);
        return [];
      default:
        return []; // message_start/message_delta/message_stop, ...
    }
  }
}

/**
 * Extract the session id from a product transcript (raw NDJSON frames):
 * the first frame carrying a string session_id is the session's identity.
 * Returns null when no frame carries one (never written by this adapter,
 * a torn file, or a foreign transcript).
 */
export function extractSessionId(transcriptText: string): string | null {
  for (const line of transcriptText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // torn tail / garbage — keep scanning
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const sid = (parsed as StreamFrame)['session_id'];
      if (typeof sid === 'string' && sid !== '') return sid;
    }
  }
  return null;
}
