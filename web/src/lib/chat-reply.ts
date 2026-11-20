/**
 * How a Gru reply reads as one bubble (owner pick 2026-11-20).
 *
 * A turn's text arrives as deltas, and tool work can sit between two
 * stretches of it. The bubble accumulates every delta of the turn, so a
 * sentence written before a tool call and the one written after it used
 * to run together ("…anything.My local copy…"). Text that resumes after
 * tool work, when the sentence before it was finished, is a new part of
 * the reply and starts its own paragraph.
 *
 * A long reply also gets a calmer bubble: short replies keep the bright
 * minion yellow, and a reply longer than about six lines reads on the
 * pale butter yellow instead of a tall block of bright colour.
 */

/** The text so far ends a sentence: closing punctuation, optionally inside
 * closing quotes, brackets or emphasis marks. */
const ENDS_SENTENCE = /[.!?…:][)\]"'”’*_`]*\s*$/u;

/** Join the reply so far with text that resumes after tool work. The break
 * is added only where a FINISHED sentence would otherwise touch the next
 * part. An empty side, a break either side already carries, and a sentence
 * the tool work interrupted mid-way ("I checked the file" … " and it is
 * fine.") are joined exactly as written. */
export function resumeReplyText(soFar: string, next: string): string {
  if (next === '' || soFar.trim() === '') return soFar + next;
  if (/\n[^\S\n]*$/u.test(soFar) || /^[^\S\n]*\n/u.test(next)) return soFar + next;
  if (!ENDS_SENTENCE.test(soFar)) return soFar + next;
  return `${soFar}\n\n${next}`;
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
