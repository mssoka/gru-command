import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { LogLevel } from '../logger.js';
import { parseTranscriptContent } from '../transcripts/service.js';
import type { JournalStore } from './journal.js';
import { isJournalKind, LessonCaptureError, type LessonDraft } from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Minion delivery-report capture (owner design: writers include "minion
 * delivery reports end with an optional `lessons` block the host
 * extracts"). The minion's block is DELIBERATE — nothing else in a
 * session is scraped, only the last assistant message's fenced block:
 *
 *   ```lessons
 *   {"kind":"finding","tags":["repo:x"],"body":"..."}
 *   {"kind":"observation","tags":[],"body":"..."}
 *   ```
 *
 * Each JSON line becomes a journal entry with source `minion:<job>`.
 */

/** Only the tail of a session file is scanned — the lessons block is by
 * convention the end of the delivery report. */
export const CAPTURE_TAIL_BYTES = 512 * 1024;

export interface LessonCapturePort {
  /** Returns the number of journal entries appended. */
  capture(input: { sessionFile: string | null; source: string }): number;
}

/** Extract the last fenced ```lessons block from text. Throws on a
 * malformed block (the caller logs it; capture is optional but never
 * silently half-read). */
export function extractLessonsBlock(text: string): readonly LessonDraft[] {
  const fence = /```lessons[ \t]*\r?\n([\s\S]*?)```/gu;
  let lastBody: string | null = null;
  for (const match of text.matchAll(fence)) lastBody = match[1] ?? null;
  if (lastBody === null) return [];
  const drafts: LessonDraft[] = [];
  for (const line of lastBody.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new LessonCaptureError(`lessons block line is not valid JSON: ${String(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new LessonCaptureError('every lessons block line must be a JSON object');
    }
    const row = parsed as Record<string, unknown>;
    const kind = row['kind'];
    if (!isJournalKind(kind)) {
      throw new LessonCaptureError('lessons block kind must be one of finding, ruling, observation');
    }
    const body = row['body'];
    if (typeof body !== 'string' || body.trim() === '') {
      throw new LessonCaptureError('lessons block body must be a non-empty string');
    }
    const tags = row['tags'] ?? [];
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) {
      throw new LessonCaptureError('lessons block tags must be an array of non-empty strings');
    }
    if (drafts.length >= 20) {
      throw new LessonCaptureError('lessons block exceeds 20 entries — split the delivery report');
    }
    drafts.push({ kind, body, tags: tags as readonly string[] });
  }
  return drafts;
}

/** Read the last assistant message from a session-file tail and extract
 * its opt-in lessons block into the journal. A capture failure is logged
 * and never fails the delivery — the lesson is a bonus, the delivery is
 * the contract. */
export function createSessionLessonsCapture(opts: {
  readonly journal: JournalStore;
  readonly log?: Log;
}): LessonCapturePort {
  const log = opts.log ?? (() => {});
  return {
    capture({ sessionFile, source }): number {
      if (sessionFile === null) return 0;
      let tail: string;
      try {
        tail = readTail(sessionFile, CAPTURE_TAIL_BYTES);
      } catch (error) {
        log('warn', 'minion lessons capture: session file unreadable', {
          session: sessionFile,
          error: String(error),
        });
        return 0;
      }
      let lastAssistant = '';
      try {
        const { entries } = parseTranscriptContent(tail);
        for (const entry of entries) {
          if (entry.kind === 'assistant' && entry.text.trim() !== '') lastAssistant = entry.text;
        }
      } catch (error) {
        log('warn', 'minion lessons capture: session tail unparseable', {
          session: sessionFile,
          error: String(error),
        });
        return 0;
      }
      if (lastAssistant === '') return 0;
      let drafts: readonly LessonDraft[];
      try {
        drafts = extractLessonsBlock(lastAssistant);
      } catch (error) {
        log('error', 'minion lessons block malformed — nothing captured (fix the report format)', {
          session: sessionFile,
          error: String(error),
        });
        return 0;
      }
      let captured = 0;
      for (const draft of drafts) {
        try {
          opts.journal.append({ kind: draft.kind, source, tags: draft.tags, body: draft.body });
          captured += 1;
        } catch (error) {
          log('error', 'minion lesson entry rejected by the journal', { error: String(error) });
          break;
        }
      }
      if (captured > 0) {
        log('info', 'minion lessons captured', { session: sessionFile, entries: captured });
      }
      return captured;
    },
  };
}

function readTail(file: string, maxBytes: number): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset);
      if (read <= 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}
