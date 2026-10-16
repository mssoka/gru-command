/** A thrown value as one bounded line of text (#379, #380): runs of
 * control, format, separator, blank and lone-surrogate characters become one
 * space, the ends are trimmed, the cut is on code points and marked with `…`
 * (so the text is at most `maxPoints` points plus that mark), and only a
 * bounded prefix is scanned. A value that cannot print, or prints as nothing,
 * is named as such. */
export function oneLineErrorText(error: unknown, maxPoints: number): string {
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 1) throw new RangeError(`oneLineErrorText needs a positive whole number of points (got ${String(maxPoints)})`);
  let text: string;
  try { text = String(error); } catch { return 'an unprintable error'; }
  // Wide enough that a run of blanks before the detail cannot hide it.
  const limit = maxPoints * 64;
  const points = [...(text.length > limit ? text.slice(0, limit) : text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Cs}]+/gu, ' ').trim()];
  if (points.length === 0) return text.length > limit ? '…' : 'an error with no text';
  return text.length > limit || points.length > maxPoints ? `${points.slice(0, maxPoints).join('')}…` : points.join('');
}
