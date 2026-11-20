/**
 * How a Gru reply reads as one bubble (owner pick 2026-11-20).
 *
 * A turn's text arrives as deltas, and tool work can sit between two
 * stretches of it. The bubble accumulates every delta of the turn, so a
 * sentence written before a tool call and the one written after it used
 * to run together ("…anything.My local copy…"), and markdown blocks on
 * either side of the seam corrupted each other. Text that resumes after
 * tool work starts its own paragraph where the parts would otherwise
 * touch (see resumeReplyText for the exact rule).
 *
 * A long reply also gets a calmer bubble: short replies keep the bright
 * minion yellow, and a reply longer than about six lines reads on the
 * pale butter yellow instead of a tall block of bright colour.
 */

/** The text so far ends a sentence: closing punctuation, optionally inside
 * closing quotes, brackets or emphasis marks. */
const ENDS_SENTENCE = /[.!?…:][)\]"'”’*_`]*\s*$/u;

/** A line that is a markdown block of its own: a code fence, a table row, a
 * heading, a list item or a quote. Text that follows one of these on the
 * same line (or the very next) is swallowed by it or changes it. */
const BLOCK_LINE = /^\s{0,3}(?:`{3,}|~{3,}|\|.*\|\s*$|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/u;

/** The next text opens with a markdown block marker. */
const STARTS_BLOCK = /^\s{0,3}(?:`{3,}|~{3,}|\||#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/u;

/** The next text carries on the sentence before it: it opens with white
 * space or a lowercase letter ("e.g." … " the port."). */
const CONTINUES = /^[\s\p{Ll},;]/u;

function lastWrittenLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.at(-1) ?? '';
}

/** True while a fenced code block is still open at the end of the text:
 * what follows is more code, and a blank line there is content. */
function insideOpenFence(text: string): boolean {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1] ?? null;
    if (fence === null) continue;
    if (open === null) open = fence[0]!;
    else if (fence[0] === open) open = null;
  }
  return open !== null;
}

/** Join the reply so far with text that resumes after tool work.
 *
 * A paragraph break is added where the two parts would otherwise run
 * together or corrupt each other:
 *   - after a line that is a block of its own (a closing code fence, a
 *     table row, a heading, a list item, a quote) — glued text would be
 *     rendered inside the code block, dropped as an extra table cell or
 *     folded into the heading;
 *   - before text that opens a block of its own;
 *   - after a finished sentence, unless the next text plainly carries the
 *     sentence on (it opens with white space or a lowercase letter).
 *
 * Everything else is joined exactly as written: an empty side, a break
 * either side already carries, text inside a code fence that is still
 * open, and a sentence the tool work interrupted mid-way ("I checked the
 * file" … " and it is fine."). */
export function resumeReplyText(soFar: string, next: string): string {
  if (next === '' || soFar.trim() === '') return soFar + next;
  if (/\n[^\S\n]*$/u.test(soFar) || /^[^\S\n]*\n/u.test(next)) return soFar + next;
  if (insideOpenFence(soFar)) return soFar + next;
  const broken = `${soFar}\n\n${next}`;
  if (BLOCK_LINE.test(lastWrittenLine(soFar)) || STARTS_BLOCK.test(next)) return broken;
  if (CONTINUES.test(next)) return soFar + next;
  return ENDS_SENTENCE.test(soFar) ? broken : soFar + next;
}

/** About six lines of chat text at the bubble's width. */
export const LONG_REPLY_CHARS = 420;
export const LONG_REPLY_LINES = 6;

/** True for a reply long enough to read better on the calm bubble: more
 * than about six lines, counted either as text length or as written lines
 * (a short reply that is mostly a list is long on the page too). */
export function isLongReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > LONG_REPLY_CHARS) return true;
  return trimmed.split('\n').filter((line) => line.trim() !== '').length > LONG_REPLY_LINES;
}
