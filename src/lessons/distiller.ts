import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import type { AgentHandle } from '../runtime/types.js';
import type { DistillInput, DistillResult, DreamDistiller } from './dream.js';
import { DreamError, isLessonsSlug, type JournalEntry, type ProposedChapter, type ProposedLesson } from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Production distiller: one Bob pass. The prompt carries the new journal
 * entries and points Bob at the bible; Bob WRITES his structured update to
 * a per-dream file, and the host applies it through BibleStore (caps,
 * dedupe counters, provenance all enforced mechanically). The file
 * protocol keeps turn attribution unambiguous even while Bob's supervised
 * slot also serves consolidation prompts.
 */

/** Clamp per-entry bodies in the prompt; the full body stays in the
 * journal file named in the entry header. */
export const DREAM_PROMPT_BODY_CLAMP = 4_000;

/** The supervised-slot surface the distiller needs. */
export interface DistillerSlot {
  ensure(): Promise<AgentHandle>;
}

export interface AgentLessonsDistillerOptions {
  readonly slot: DistillerSlot;
  readonly bibleDir: string;
  /** Prompt wait budget; default 20 minutes (a distillation can be slow). */
  readonly promptTimeoutMs?: number;
  readonly log?: Log;
}

export class AgentLessonsDistiller implements DreamDistiller {
  private readonly opts: AgentLessonsDistillerOptions;
  private readonly log: Log;

  constructor(opts: AgentLessonsDistillerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  async distill(input: DistillInput): Promise<DistillResult> {
    const outputFile = join(this.opts.bibleDir, `.dream-output-${randomUUID()}.json`);
    const handle = await this.opts.slot.ensure();
    const prompt = renderDreamPrompt({ ...input, outputFile });
    await handle.prompt(prompt, {
      owner: 'lessons-dream',
      timeoutMs: this.opts.promptTimeoutMs ?? 1_200_000,
    });
    let raw: string;
    try {
      raw = readFileSync(outputFile, 'utf-8');
    } catch (error) {
      // A failed output file stays on disk for forensics; the retry writes
      // a fresh nonce, so a stale file can never be mistaken for this run.
      throw new DreamError(
        `the dream distiller did not write its output file ${outputFile} (${String(error)}) — ` +
          'the journal cursor stays put and the next dream retries',
      );
    }
    const result = parseDreamOutput(raw, input.entries);
    rmSync(outputFile, { force: true });
    this.log('info', 'dream distiller output accepted', {
      chapters: result.chapters.length,
      entries: input.entries.length,
    });
    return result;
  }
}

export interface DreamPromptInput extends DistillInput {
  readonly outputFile: string;
}

/** Render the one-pass dream prompt. Deterministic; the entries are the
 * ONLY source of new facts and their ids are the ONLY legal provenance. */
export function renderDreamPrompt(input: DreamPromptInput): string {
  const journalLines = input.entries.map((entry) => JSON.stringify(clampEntry(entry))).join('\n');
  return [
    'Book of Lessons — dream pass.',
    '',
    'You are Bob, the memory agent. Consolidate NEW journal entries into the',
    'existing book of lessons. This is distillation, not transcription:',
    'merge repeats into existing lessons, keep only what a future worker',
    'would act on, and cite provenance.',
    '',
    `The book lives at: ${input.bibleDir}`,
    'Read its README.md and the chapters you touch before deciding.',
    '',
    'New journal entries since the last dream (JSON Lines, oldest first;',
    'ids are the only legal provenance):',
    journalLines,
    '',
    'Rules:',
    '- DEDUPE: a finding that repeats an existing lesson must merge into it.',
    '  Name the existing lesson slug in "mergeInto" (within the same chapter),',
    '  or reuse its slug. The host bumps its recurred counter and unions the',
    '  provenance — never duplicate a lesson.',
    '- Every new lesson cites at least one journal id from the list above.',
    '- Write the fewest words that carry the lesson. Never paste journal text',
    '  verbatim. No markdown headings inside bodies.',
    '- Touch only chapters affected by the new entries. To retire a chapter,',
    '  carry its live lessons into other chapters and set "retire": true.',
    `- Chapters are capped at ${input.chapterCapBytes} bytes; the index at`,
    `  ${input.indexCapBytes} bytes and must be able to list every chapter —`,
    '  consolidate overlapping chapters instead of growing the book.',
    '',
    'Write EXACTLY ONE file — this exact path, valid JSON, nothing else:',
    input.outputFile,
    '',
    'Schema:',
    '{"chapters":[{"slug":"kebab-case","title":"...","summary":"one line",',
    '"tags":["..."],"lessons":[{"slug":"kebab-case",',
    '"body":"the lesson","tags":["..."],"journalIds":["j-1"],',
    '"mergeInto":"existing-lesson-slug (optional)"}]}]}',
    '',
    'When the file is written, reply with one line confirming the dream is done.',
  ].join('\n');
}

function clampEntry(entry: JournalEntry): JournalEntry {
  if (entry.body.length <= DREAM_PROMPT_BODY_CLAMP) return entry;
  return {
    ...entry,
    body: `${entry.body.slice(0, DREAM_PROMPT_BODY_CLAMP)} … [entry truncated for the dream prompt; full body in the journal file]`,
  };
}

/** Parse + validate Bob's structured output. Strict at the boundary: the
 * store's invariants depend on this shape. */
export function parseDreamOutput(raw: string, entries: readonly JournalEntry[]): DistillResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DreamError(`dream output is not valid JSON (${String(error)})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DreamError('dream output must be a JSON object of the shape {"chapters":[...]}');
  }
  const chaptersRaw = (parsed as Record<string, unknown>)['chapters'];
  if (!Array.isArray(chaptersRaw)) {
    throw new DreamError('dream output is missing the "chapters" array');
  }
  const known = new Set(entries.map((entry) => entry.id));
  const chapters: ProposedChapter[] = chaptersRaw.map((value, index) =>
    parseProposedChapter(value, index, known),
  );
  return { chapters };
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DreamError(`dream output ${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DreamError(`dream output ${where} must be a non-empty string`);
  }
  return value;
}

function requireSlug(value: unknown, where: string): string {
  const slug = requireString(value, where);
  if (!isLessonsSlug(slug)) {
    throw new DreamError(`dream output ${where} must be a kebab-case slug (got ${JSON.stringify(slug)})`);
  }
  return slug;
}

function optionalTags(value: unknown, where: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string' || tag.trim() === '')) {
    throw new DreamError(`dream output ${where} must be an array of non-empty strings`);
  }
  return value as readonly string[];
}

function parseProposedLesson(value: unknown, where: string, known: ReadonlySet<string>): ProposedLesson {
  const row = requireObject(value, where);
  const slug = requireSlug(row['slug'], `${where}.slug`);
  const body = requireString(row['body'], `${where}.body`);
  const tags = optionalTags(row['tags'], `${where}.tags`);
  const journalIdsRaw = row['journalIds'];
  if (!Array.isArray(journalIdsRaw) || journalIdsRaw.some((id) => typeof id !== 'string')) {
    throw new DreamError(`dream output ${where}.journalIds must be an array of journal ids`);
  }
  const journalIds = journalIdsRaw as string[];
  if (journalIds.length === 0) {
    throw new DreamError(`dream output ${where} cites no journal id — provenance is mandatory`);
  }
  for (const id of journalIds) {
    if (!known.has(id)) {
      throw new DreamError(
        `dream output ${where} cites journal id ${id} which was not in this dream batch — provenance may not be invented`,
      );
    }
  }
  const mergeIntoRaw = row['mergeInto'];
  const mergeInto = mergeIntoRaw === undefined ? undefined : requireSlug(mergeIntoRaw, `${where}.mergeInto`);
  return {
    slug,
    body,
    journalIds,
    ...(tags !== undefined ? { tags } : {}),
    ...(mergeInto !== undefined ? { mergeInto } : {}),
  };
}

function parseProposedChapter(value: unknown, index: number, known: ReadonlySet<string>): ProposedChapter {
  const where = `chapters[${index}]`;
  const row = requireObject(value, where);
  const slug = requireSlug(row['slug'], `${where}.slug`);
  const title = requireString(row['title'], `${where}.title`);
  const summary = requireString(row['summary'], `${where}.summary`);
  const tags = optionalTags(row['tags'], `${where}.tags`);
  const retire = row['retire'];
  if (retire !== undefined && retire !== true && retire !== false) {
    throw new DreamError(`dream output ${where}.retire must be a boolean`);
  }
  const lessonsRaw = row['lessons'] ?? (retire === true ? [] : undefined);
  if (!Array.isArray(lessonsRaw)) {
    throw new DreamError(`dream output ${where}.lessons must be an array`);
  }
  const lessons = lessonsRaw.map((lesson, lessonIndex) =>
    parseProposedLesson(lesson, `${where}.lessons[${lessonIndex}]`, known),
  );
  return {
    slug,
    title,
    summary,
    lessons,
    ...(tags !== undefined ? { tags } : {}),
    ...(retire === true ? { retire: true } : {}),
  };
}
