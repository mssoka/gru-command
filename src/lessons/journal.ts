import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import {
  isJournalKind,
  JOURNAL_KINDS,
  JournalError,
  type JournalEntry,
  type JournalKind,
} from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The journal: an append-only store of deliberate entries — one JSONL file
 * per source-day (`journal/YYYY-MM-DD.jsonl`). JSONL is the call (over a
 * ledger table) because the journal is a judgment trail, not an operational
 * record: it stays human/tool readable with file tools alone, needs no
 * schema migrations, and appends are single writes. The ledger remains the
 * record of what happened; the journal records what was learned.
 *
 * Nothing writes here automatically except the deliberate paths: Gru/Silas
 * appends through the authenticated API, and the host extracts a minion's
 * opt-in `lessons` block at delivery. Noise is a bug.
 */

/** Body ceiling — a journal entry is a note, not a document. */
export const JOURNAL_BODY_MAX_CHARS = 16_000;
export const JOURNAL_MAX_TAGS = 16;
export const JOURNAL_MAX_TAG_CHARS = 64;

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export interface JournalAppendInput {
  readonly kind: JournalKind;
  readonly source: string;
  readonly tags?: readonly string[];
  readonly body: string;
}

export interface JournalListOptions {
  /** Exclusive lower bound on seq (the dream cursor). */
  readonly after?: number;
  /** Maximum entries returned (default 500, hard max 10 000). */
  readonly limit?: number;
}

export class JournalStore {
  readonly dir: string;
  private readonly log: Log;
  /** In-memory high-water mark; null until the first read/append. */
  private seq: number | null = null;

  constructor(dir: string, opts: { log?: Log } = {}) {
    this.dir = dir;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Append one deliberate entry. Validation fails loud (a malformed entry
   * is a caller bug, not something to store anyway).
   */
  append(input: JournalAppendInput, now: Date = new Date()): JournalEntry {
    if (!isJournalKind(input.kind)) {
      throw new JournalError(
        `journal kind must be one of: ${JOURNAL_KINDS.join(', ')} (got ${JSON.stringify(input.kind)})`,
      );
    }
    const source = input.source;
    if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) {
      throw new JournalError(
        `journal source must match ${SOURCE_PATTERN} (e.g. "gru", "silas", "minion:<job>", "owner") — got ${JSON.stringify(source)}`,
      );
    }
    const body = input.body;
    if (typeof body !== 'string' || body.trim() === '') {
      throw new JournalError('journal body must be a non-empty string');
    }
    if (body.length > JOURNAL_BODY_MAX_CHARS) {
      throw new JournalError(
        `journal body exceeds ${JOURNAL_BODY_MAX_CHARS} characters (got ${body.length}) — split it into deliberate entries`,
      );
    }
    const tags = this.validateTags(input.tags ?? []);
    const seq = this.nextSeq();
    const ts = now.toISOString();
    const entry: JournalEntry = { seq, id: `j-${seq}`, ts, kind: input.kind, source, tags, body };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(this.dir, `${ts.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf-8');
    this.log('debug', 'journal entry appended', { id: entry.id, kind: entry.kind, source: entry.source });
    return entry;
  }

  /** Entries with seq > after, oldest first (the shape the dream consumes). */
  list(options: JournalListOptions = {}): readonly JournalEntry[] {
    const after = options.after ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 10_000);
    return this.readAll()
      .filter((entry) => entry.seq > after)
      .slice(0, limit);
  }

  /** The current high-water sequence (0 for an empty journal). */
  latestSeq(): number {
    if (this.seq === null) {
      this.seq = this.readAll().reduce((max, entry) => Math.max(max, entry.seq), 0);
    }
    return this.seq;
  }

  private nextSeq(): number {
    const next = this.latestSeq() + 1;
    this.seq = next;
    return next;
  }

  private validateTags(tags: readonly string[]): readonly string[] {
    if (!Array.isArray(tags)) throw new JournalError('journal tags must be an array of strings');
    if (tags.length > JOURNAL_MAX_TAGS) {
      throw new JournalError(`journal tags exceed ${JOURNAL_MAX_TAGS} entries (got ${tags.length})`);
    }
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.trim() === '') {
        throw new JournalError('journal tags must be non-empty strings');
      }
      if (tag.length > JOURNAL_MAX_TAG_CHARS) {
        throw new JournalError(
          `journal tag ${JSON.stringify(tag)} exceeds ${JOURNAL_MAX_TAG_CHARS} characters`,
        );
      }
    }
    return tags;
  }

  /**
   * Read every entry, oldest first. A malformed line fails loud naming the
   * file and line — a corrupt journal must never be silently half-read
   * (the operator repairs or removes the line; entries stay append-only).
   */
  private readAll(): JournalEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw new JournalError(`journal dir ${this.dir} is unreadable: ${String(error)}`);
    }
    const entries: JournalEntry[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith('.jsonl')).sort()) {
      const file = join(this.dir, name);
      let text: string;
      try {
        text = readFileSync(file, 'utf-8');
      } catch (error) {
        throw new JournalError(`journal file ${file} is unreadable: ${String(error)}`);
      }
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (line.trim() === '') continue;
        entries.push(this.parseEntry(file, index + 1, line));
      }
    }
    entries.sort((a, b) => a.seq - b.seq);
    return entries;
  }

  private parseEntry(file: string, line: number, raw: string): JournalEntry {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new JournalError(
        `journal file ${file}:${line} is not valid JSON (${String(error)}) — repair or remove the line`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new JournalError(`journal file ${file}:${line} is not a JSON object — repair or remove the line`);
    }
    const row = parsed as Record<string, unknown>;
    const bad = (why: string): never => {
      throw new JournalError(`journal file ${file}:${line}: ${why} — repair or remove the line`);
    };
    const seq = row['seq'];
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) bad('seq must be a positive integer');
    const id = row['id'];
    if (typeof id !== 'string' || id === '') bad('id must be a non-empty string');
    const ts = row['ts'];
    if (typeof ts !== 'string' || ts === '') bad('ts must be a non-empty string');
    const kind = row['kind'];
    if (!isJournalKind(kind)) bad(`kind must be one of finding, ruling, observation`);
    const source = row['source'];
    if (typeof source !== 'string' || source === '') bad('source must be a non-empty string');
    const body = row['body'];
    if (typeof body !== 'string' || body === '') bad('body must be a non-empty string');
    const tags = row['tags'];
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) bad('tags must be an array of strings');
    return {
      seq: seq as number,
      id: id as string,
      ts: ts as string,
      kind: kind as JournalKind,
      source: source as string,
      tags: tags as readonly string[],
      body: body as string,
    };
  }
}
