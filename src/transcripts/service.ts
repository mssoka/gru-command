import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseSessionEntries } from '@earendil-works/pi-coding-agent';
import type { LedgerApi } from '../ledger/api.js';

/**
 * Minimal STRUCTURAL shapes for session message entries — deliberately
 * not the SDK's full AgentMessage type: the transcript view only needs
 * role + content blocks + timestamps, and narrow local shapes keep the
 * renderer stable as the SDK type evolves.
 */
interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}
interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
}
interface ImageBlock {
  readonly type: 'image';
}
interface ToolResultShape {
  readonly role: 'toolResult';
  readonly content: string | readonly (TextBlock | ImageBlock)[];
  readonly timestamp?: number;
  readonly toolName?: string;
  readonly isError?: boolean;
}
interface UserShape {
  readonly role: 'user';
  readonly content: string | readonly (TextBlock | ImageBlock)[];
  readonly timestamp?: number;
}
interface AssistantShape {
  readonly role: 'assistant';
  readonly content: readonly (TextBlock | ThinkingBlock | OtherBlock)[];
  readonly timestamp?: number;
  readonly stopReason?: string;
}
interface OtherBlock {
  readonly type: string;
}
type AnyMessage = UserShape | AssistantShape | ToolResultShape;

/**
 * Agent transcript views (EPICS E6 story 4): searchable, scrollable
 * per-agent transcripts served from the session store's append-only jsonl
 * — better than a terminal pane by design: full scrollback, unwrapped
 * long lines, and server-side search so the client never loads a whole
 * transcript. Parsed with the SDK's own session parser; a torn tail line
 * (an active session mid-append) is skipped and counted, never fatal.
 */

export interface TranscriptInfo {
  /** Path relative to the sessions dir (the safe handle clients use). */
  readonly file: string;
  readonly role: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  /** Ledger agent id bound to this file, when known. */
  readonly agentId: string | null;
  readonly agentLabel: string | null;
}

export type TranscriptKind = 'user' | 'assistant' | 'tool_result' | 'system' | 'other';

export interface TranscriptEntry {
  /** 0-based index from the file start (stable pagination cursor). */
  readonly index: number;
  readonly ts: number | null;
  readonly kind: TranscriptKind;
  readonly role: string | null;
  /** Flattened text (user/assistant text blocks joined). */
  readonly text: string;
  readonly thinking: string | null;
  readonly toolName: string | null;
  readonly isError: boolean;
}

export interface TranscriptPage {
  readonly file: string;
  readonly total: number;
  /** Entries newest-last, newest FIRST when paging backwards. */
  readonly entries: readonly TranscriptEntry[];
  /** Cursor to fetch older entries; null when the file start is reached. */
  readonly nextCursor: number | null;
  readonly skippedTornLines: number;
}

export interface TranscriptMatch {
  readonly index: number;
  readonly kind: TranscriptKind;
  readonly snippet: string;
}

export interface TranscriptSearchResult {
  readonly file: string;
  readonly query: string;
  readonly matches: readonly TranscriptMatch[];
  /** Search scans at most this many entries (bounded work per request). */
  readonly scanned: number;
  /** Total entries in the file — scanned < total means the scan was
   * truncated (oldest entries beyond the cap were not searched). */
  readonly total: number;
}

/** Transcripts larger than this refuse to serve (fail-loud) — an
 * unbounded parse would block the single-threaded server. */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/** Parsed-transcript cache entries (parse-once per file revision). */
const CACHE_LIMIT = 8;

interface CacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly entries: readonly TranscriptEntry[];
  readonly tornLines: number;
}

export class TranscriptService {
  readonly sessionsDir: string;
  private readonly ledger: LedgerApi | null;
  private readonly searchScanLimit: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(sessionsDir: string, opts: { ledger?: LedgerApi; searchScanLimit?: number } = {}) {
    this.sessionsDir = resolve(sessionsDir);
    this.ledger = opts.ledger ?? null;
    this.searchScanLimit = opts.searchScanLimit ?? 5_000;
  }

  /** Canonical sessions dir, resolved lazily per confinement check (the
   * dir may not exist at construction; macOS temp dirs are themselves
   * symlinked, so BOTH sides must go through realpath). */
  private realSessionsDirNow(): string {
    try {
      return realpathSync(this.sessionsDir);
    } catch {
      return this.sessionsDir;
    }
  }

  /** All session files under the store, newest first. */
  list(): readonly TranscriptInfo[] {
    const agentByFile = new Map<string, { id: string; label: string | null }>();
    if (this.ledger !== null) {
      for (const agent of this.ledger.listAgents()) {
        if (agent.sessionFile !== null) {
          agentByFile.set(resolve(agent.sessionFile), { id: agent.id, label: agent.label });
        }
      }
    }
    const out: TranscriptInfo[] = [];
    for (const file of this.walkJsonl(this.sessionsDir)) {
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue; // vanished mid-walk
      }
      const rel = relative(this.sessionsDir, file);
      const agent = agentByFile.get(resolve(file));
      out.push({
        file: rel.split(sep).join('/'),
        role: roleFromRelPath(rel),
        sizeBytes: stat.size,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        agentId: agent?.id ?? null,
        agentLabel: agent?.label ?? null,
      });
    }
    out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return out;
  }

  private walkJsonl(dir: string): string[] {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...this.walkJsonl(full));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
    return files;
  }

  /**
   * Resolve a client-supplied relative path against the sessions dir and
   * CONFIRM confinement — lexically AND through symlinks (realpath): a
   * link planted inside the store pointing outside must not escape.
   * Traversal attempts throw (rejected loudly, the caller maps that).
   */
  resolveConfined(relFile: string): string {
    if (relFile === '' || relFile.includes('\0')) {
      throw new Error('invalid transcript path');
    }
    const full = resolve(this.sessionsDir, relFile);
    const rel = relative(this.sessionsDir, full);
    if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || rel.includes(`../`) || resolve(full) === this.sessionsDir) {
      throw new Error(`transcript path escapes the session store: ${relFile}`);
    }
    let real: string;
    try {
      real = realpathSync(full);
    } catch {
      throw new Error(`transcript unreadable: no such file (${relFile})`);
    }
    const realRoot = this.realSessionsDirNow();
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`transcript path escapes the session store (symlink): ${relFile}`);
    }
    return full;
  }

  /**
   * Parse the file into transcript entries (server-side; the client only
   * ever sees bounded pages). Parsed once per (mtime, size) revision —
   * repeated paging/searches hit the cache, and a live-appended file
   * (mtime change) re-parses.
   */
  read(relFile: string): { entries: readonly TranscriptEntry[]; tornLines: number } {
    const full = this.resolveConfined(relFile);
    let stat;
    try {
      stat = statSync(full);
    } catch (error) {
      throw new Error(`transcript unreadable: ${String(error)}`);
    }
    if (stat.size > MAX_TRANSCRIPT_BYTES) {
      throw new Error(
        `transcript too large to serve (${stat.size} bytes > ${MAX_TRANSCRIPT_BYTES}); archive or split the session file`,
      );
    }
    const cached = this.cache.get(relFile);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { entries: cached.entries, tornLines: cached.tornLines };
    }
    let content: string;
    try {
      content = readFileSync(full, 'utf-8');
    } catch (error) {
      throw new Error(`transcript unreadable: ${String(error)}`);
    }
    const parsed = parseTranscriptContent(content);
    this.cache.delete(relFile);
    this.cache.set(relFile, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries: parsed.entries,
      tornLines: parsed.tornLines,
    });
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return parsed;
  }

  /**
   * Newest-first pagination: `before` is an exclusive upper index bound
   * (entries with index < before). Returns up to `limit` entries in
   * descending index order plus the next cursor (or null at file start).
   */
  page(relFile: string, opts: { before?: number; limit?: number } = {}): TranscriptPage {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const { entries, tornLines } = this.read(relFile);
    const total = entries.length;
    const upper = opts.before === undefined ? total : Math.max(0, Math.min(opts.before, total));
    const lower = Math.max(0, upper - limit);
    const slice = entries.slice(lower, upper).reverse(); // descending index
    return {
      file: relFile,
      total,
      entries: slice,
      nextCursor: lower > 0 ? lower : null,
      skippedTornLines: tornLines,
    };
  }

  /**
   * Case-insensitive substring search across entry text + thinking,
   * scanning NEWEST-FIRST under the scan cap (recent activity is what
   * users search for; truncation is disclosed via scanned vs total).
   */
  search(relFile: string, query: string): TranscriptSearchResult {
    const q = query.toLowerCase();
    const { entries } = this.read(relFile);
    const total = entries.length;
    const scanned = Math.min(total, this.searchScanLimit);
    const matches: TranscriptMatch[] = [];
    for (let offset = 0; offset < scanned; offset += 1) {
      const entry = entries[total - 1 - offset];
      if (entry === undefined) continue;
      const haystacks = [entry.text, entry.thinking ?? ''];
      for (const hay of haystacks) {
        const at = hay.toLowerCase().indexOf(q);
        if (at >= 0) {
          matches.push({
            index: entry.index,
            kind: entry.kind,
            snippet: snippetAround(hay, at, q.length),
          });
          break;
        }
      }
    }
    return { file: relFile, query, matches, scanned, total };
  }
}

function snippetAround(text: string, at: number, len: number): string {
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + len + 60);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/** sessions/<role>/<dir>/<file>.jsonl → <role> ('' when unknown layout). */
function roleFromRelPath(rel: string): string {
  const parts = rel.split(sep);
  const role = parts[0] ?? '';
  if (parts.length >= 3 && ['gru', 'silas', 'minion', 'perkins', 'bob'].includes(role)) {
    return role;
  }
  return '';
}

/**
 * Parse raw session-file content with the SDK's own (tolerant) parser:
 * unparsable lines — a torn tail from a live append, stray garbage — are
 * skipped by the parser itself; we COUNT them by line arithmetic so the
 * UI can disclose "N lines skipped" instead of hiding data loss.
 */
export function parseTranscriptContent(content: string): {
  entries: TranscriptEntry[];
  tornLines: number;
} {
  const entries: TranscriptEntry[] = [];
  const parsed = parseSessionEntries(content);
  const nonEmptyLines = content.split('\n').filter((l) => l.trim() !== '').length;
  const tornLines = Math.max(0, nonEmptyLines - parsed.length);
  for (const entry of parsed) {
    if (entry.type === 'session') continue; // header
    if (entry.type === 'message') {
      const message = (entry as { message: AnyMessage }).message;
      entries.push(entryFromMessage(entries.length, message));
      continue;
    }
    const claude = claudeFrameEntry(entry, entries.length);
    if (claude !== null) entries.push(claude);
    // else: claude-code raw stream frames (init metadata, stream_event
    // deltas) are duplicate representations of the assistant/user message
    // entries already rendered — skipping them is dedupe, not data loss.
  }
  return { entries, tornLines };
}

/**
 * claude-code adapter frames (raw stream-json forensics appended to the
 * session file): user/assistant frames carry an anthropic-shaped message;
 * result frames mark turn outcomes. Everything else (system init,
 * stream_event deltas) returns null — covered by the message entries.
 */
function claudeFrameEntry(rawEntry: object, index: number): TranscriptEntry | null {
  const entry = rawEntry as Record<string, unknown>;
  const type = String(entry['type'] ?? '');
  if (type === 'user' || type === 'assistant') {
    const message = entry['message'];
    if (typeof message !== 'object' || message === null) return null;
    const content = (message as { content?: unknown }).content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'object' && block !== null) {
          const blockText = (block as { text?: unknown }).text;
          if (typeof blockText === 'string') text += blockText;
          else if ((block as { type?: unknown }).type === 'image') text += '[image]';
        }
      }
    }
    return {
      index,
      ts: null,
      kind: type === 'user' ? 'user' : 'assistant',
      role: type,
      text,
      thinking: null,
      toolName: null,
      isError: false,
    };
  }
  if (type === 'result') {
    const subtype = entry['subtype'];
    return {
      index,
      ts: null,
      kind: 'system',
      role: null,
      text: `turn result: ${typeof subtype === 'string' ? subtype : 'unknown'}`,
      thinking: null,
      toolName: null,
      isError: subtype === 'error_during_execution' || subtype === 'error_max_turns',
    };
  }
  return null;
}

function entryFromMessage(index: number, message: AnyMessage): TranscriptEntry {
  const ts = typeof message.timestamp === 'number' ? message.timestamp : null;
  if (message.role === 'user') {
    return {
      index,
      ts,
      kind: 'user',
      role: 'user',
      text: flattenText(message.content),
      thinking: null,
      toolName: null,
      isError: false,
    };
  }
  if (message.role === 'assistant') {
    let text = '';
    let thinking: string | null = null;
    for (const block of message.content) {
      if (block.type === 'text') text += (block as TextBlock).text;
      else if (block.type === 'thinking') thinking = (thinking ?? '') + (block as ThinkingBlock).thinking;
    }
    return {
      index,
      ts,
      kind: 'assistant',
      role: 'assistant',
      text,
      thinking,
      toolName: null,
      isError: message.stopReason === 'error',
    };
  }
  // toolResult
  return {
    index,
    ts,
    kind: 'tool_result',
    role: 'tool',
    text: flattenText(message.content),
    thinking: null,
    toolName: message.toolName ?? null,
    isError: message.isError === true,
  };
}

function flattenText(content: string | readonly (TextBlock | ImageBlock)[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block.type === 'text') out += block.text;
    else if (block.type === 'image') out += '[image]';
  }
  return out;
}
