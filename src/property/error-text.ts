/** A thrown value as one bounded line of text (#379, #380): runs of
 * control, format, separator and blank characters become one space, the ends are
 * trimmed, the cut never splits a surrogate pair and is marked, and only a
 * bounded prefix is ever read — a huge value costs no more than a short one,
 * and one that cannot print is named as such. */
export function oneLineErrorText(error: unknown, maxPoints: number): string {
  let text: string;
  try { text = String(error); } catch { return 'an unprintable error'; }
  const limit = maxPoints * 4;
  const points = [...(text.length > limit ? text.slice(0, limit) : text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]+/gu, ' ').trim()];
  return text.length > limit || points.length > maxPoints ? `${points.slice(0, maxPoints).join('')}…` : points.join('');
}
