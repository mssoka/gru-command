/**
 * Board display vocabulary (v6.1, owner ruling 2026-09-23): the words the
 * operator reads, mapped ONCE at the render boundary. The data model,
 * API, docs, and identifiers keep `lane`, `job(s)`, and `agent`; the
 * display layer renders:
 *
 *   lane / job  → heist / heists   (the unit of work)
 *   worker meta → minion           (never "agent" in a rendered string)
 *   the agents rail of gru + silas + minions + lens children → CREW
 *
 * One constant so every surface draws the same word. This is a display
 * vocabulary, never a rename: `BOARD_WORDS` maps the words; nothing here
 * touches the wire protocol or the ledger's own names.
 */

export const BOARD_WORDS = {
  /** One unit of work — the lane + job pair, as the operator says it. */
  heist: 'heist',
  heists: 'heists',
  /** The worker-meta word: api/code say "agent", the screen says minion. */
  minion: 'minion',
  /** The agents rail's rendered label (gru, silas, minions, lens children). */
  crew: 'crew',
} as const;

/** `1 heist` / `3 heists` — the operator-facing count for a band heading. */
export function heistCount(count: number): string {
  return `${count} ${count === 1 ? BOARD_WORDS.heist : BOARD_WORDS.heists}`;
}
