/** Every control, format, line or paragraph separator, private-use and
 * unassigned code point: the characters that can break, reorder or hide a
 * rendered line — the same classes silas_action text refuses. */
const LINE_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu;
const LINE_UNSAFE_ANY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;

/** Text as one JSON literal with every line-unsafe character `\uXXXX`-escaped
 * (JSON.stringify alone escapes only C0 controls and lone surrogates). */
export const lineSafeLiteral = (text: string): string =>
  JSON.stringify(text).replace(LINE_UNSAFE, (char) => Array.from({ length: char.length }, (_, unit) => `\\u${char.charCodeAt(unit).toString(16).padStart(4, '0')}`).join(''));

/** Text a guidance line shows: as written when it is line-safe and at most
 * `maxPoints` code points; otherwise its line-safe literal, cut on code points
 * and marked — never anything that can break, reorder or flood the line. */
export function shownText(text: string, maxPoints = 200): string {
  const points = [...text.slice(0, maxPoints * 2 + 1)];
  // Whole when no more than twice the bound in units: then `points` is all of it.
  const whole = text.length <= maxPoints * 2;
  if (whole && points.length <= maxPoints && !LINE_UNSAFE_ANY.test(text)) return text;
  return points.length > maxPoints ? `${lineSafeLiteral(points.slice(0, maxPoints).join(''))}…` : lineSafeLiteral(points.join(''));
}
