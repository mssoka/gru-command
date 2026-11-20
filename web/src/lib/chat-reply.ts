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

/** Lines that are markdown blocks of their own. */
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/u;
const RULE_LINE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/u;
const TABLE_ROW = /^\s{0,3}\|.*\|\s*$/u;
const HEADING = /^\s{0,3}#{1,6}\s/u;
const QUOTE = /^\s{0,3}>/u;

/** The next text opens with a markdown block marker. */
const STARTS_BLOCK = /^\s{0,3}(?:`{3,}|~{3,}|\||#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/u;
const STARTS_TABLE_ROW = /^\s{0,3}\|/u;

/** The next text plainly carries on the line before it: it opens with white
 * space or with punctuation that cannot begin a new part ("e.g." … " the
 * port."; "the count is 3" … ", as expected."). A reply resumes after tool
 * work at the start of a new block of text, so anything else — a capital, a
 * lowercase word, a digit — begins something new. */
const CONTINUES = /^[\s,;)\]]/u;

function lastWrittenLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.at(-1) ?? '';
}

/** True while a fenced code block is still open at the end of the text:
 * what follows is more code, and a blank line there is content. A fence is
 * closed only by a line of the same character, at least as long, with
 * nothing after it (CommonMark). */
function insideOpenFence(text: string): boolean {
  let open: { readonly char: string; readonly length: number } | null = null;
  for (const line of text.split('\n')) {
    const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (match === null) continue;
    const fence = match[1]!;
    if (open === null) open = { char: fence[0]!, length: fence.length };
    else if (fence[0] === open.char && fence.length >= open.length && match[2]!.trim() === '') open = null;
  }
  return open !== null;
}

/** Join the reply so far with ALL the text that has resumed after tool
 * work (the caller re-joins as more of it arrives: live text comes a token
 * at a time, and "-" is not yet a list item).
 *
 * The join is chosen so the two parts neither run together nor corrupt
 * each other:
 *   - inside a code fence that is still open: as written (a blank line
 *     there is content);
 *   - after a closing code fence or a rule line: a new paragraph, always
 *     (text on that line would reopen or swallow the block);
 *   - a list item followed by a list item, a table row followed by a table
 *     row: the next line of the same block;
 *   - before text that opens a block of its own: a new paragraph;
 *   - text that plainly carries on (it opens with white space or closing
 *     punctuation): as written, even on a heading, a list item or a table
 *     row cut mid-way;
 *   - after a heading, a list item, a table row or a quote, and after a
 *     finished sentence: a new paragraph;
 *   - otherwise (a sentence the tool work interrupted mid-way): as
 *     written.
 * An empty side, or a break either side already carries, is left alone. */
export function resumeReplyText(soFar: string, next: string): string {
  const written = soFar + next;
  if (next === '' || soFar.trim() === '') return written;
  if (/\n[^\S\n]*$/u.test(soFar) || /^[^\S\n]*\n/u.test(next)) return written;
  if (insideOpenFence(soFar)) return written;
  const paragraph = `${soFar}\n\n${next}`;
  const line = lastWrittenLine(soFar);
  if (FENCE_LINE.test(line) || RULE_LINE.test(line)) return paragraph;
  if (LIST_ITEM.test(line) && LIST_ITEM.test(next)) return `${soFar}\n${next}`;
  if (TABLE_ROW.test(line) && STARTS_TABLE_ROW.test(next)) return `${soFar}\n${next}`;
  if (STARTS_BLOCK.test(next)) return paragraph;
  if (CONTINUES.test(next)) return written;
  if (LIST_ITEM.test(line) || TABLE_ROW.test(line) || HEADING.test(line) || QUOTE.test(line)) return paragraph;
  return ENDS_SENTENCE.test(soFar) ? paragraph : written;
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
