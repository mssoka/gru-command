/**
 * Shared time helpers (board UX v4): one age formatter and one local-day
 * predicate so the KPI strip, band bucketer, and health row all read the
 * same clock the same way. Unparseable/missing stamps render an honest
 * em dash, never a fake number.
 */

/** `12s`, `4m`, `2h`, `3d` — compact age for live surfaces. */
export function formatAge(iso: string | null, now = Date.now()): string {
  if (iso === null) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.floor((now - then) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Age in ms (null when the stamp is absent/unparseable). */
export function ageMs(iso: string | null, now = Date.now()): number | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, now - then);
}

/** Same LOCAL calendar day as `now` — the operator's "today", not UTC. */
export function isSameLocalDay(iso: string | null, now = new Date()): boolean {
  if (iso === null) return false;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return false;
  return (
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  );
}

/** First 8 chars of a git sha (or `unknown`). */
export function shortRev(rev: string | null): string {
  return rev === null || rev === '' ? 'unknown' : rev.slice(0, 8);
}
