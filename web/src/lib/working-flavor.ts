/**
 * Working-state flavor copy (owner-approved 2026-10-01,
 * `GRU-WORKING-FLAVOR-20261001`).
 *
 * While the authoritative chat context is connected and `busy`, the status
 * chip rotates one of these phrases every `WORKING_FLAVOR_INTERVAL_MS`.
 * The copy is decoration for one real local state: it is never progress,
 * instructions, job events, or model output, and it must never drive
 * anything but that chip's text.
 *
 * `WorkingFlavorDeck` owns the shuffle contract:
 *   - each bag is a permutation of all 100 approved phrases (nothing
 *     repeats until the full pool has been shown);
 *   - categories interleave round-robin with an adjacency guard, so no
 *     two consecutive phrases share a category (no banana/minion runs) —
 *     the stronger rule that also makes a bag boundary repeat impossible,
 *     since the previous phrase's category is excluded from the next
 *     bag's opening round.
 *   - a new bag never starts with the phrase that just ended the previous
 *     bag.
 *
 * The deck is stateful on purpose: the mounted chat view keeps ONE deck so
 * the bag survives working episodes. No persistence, no API, no traffic.
 */

export const WORKING_FLAVOR_INTERVAL_MS = 4000;

export interface WorkingFlavorCategory {
  readonly id: string;
  readonly phrases: readonly string[];
}

/**
 * The approved pool, verbatim: order, curly quotes, and casing are part of
 * the approval. The focused test pins the joined copy's SHA-256, so edits
 * require an owner-approved copy change plus an explicit pin update.
 */
export const WORKING_FLAVOR_CATEGORIES: readonly WorkingFlavorCategory[] = [
  {
    id: 'schemes-heists',
    phrases: [
      'Plotting',
      'Scheming',
      'Conspiring',
      'Masterminding',
      'Hatching plots',
      'Brewing trouble',
      'Calculating chaos',
      'Perfecting Plan B',
      'Rehearsing the heist',
      'Drawing blueprints',
      'Finding loopholes',
      'Inventing alibis',
      'Measuring the Moon',
      'Outsmarting gravity',
      'Planning the getaway',
      'Practicing stealth',
      'Packing escape snacks',
      'Adjusting the disguise',
      'Counting down ominously',
      'Overthinking everything',
    ],
  },
  {
    id: 'minion-management',
    phrases: [
      'Wrangling minions',
      'Herding minions',
      'Counting minions',
      'Locating Kevin',
      'Redirecting Bob',
      'Distracting Stuart',
      'Consulting Nefario',
      'Blaming the minions',
      'Untangling goggles',
      'Inspecting overalls',
      'Collecting tiny hardhats',
      'Decoding Minionese',
      'Negotiating snack breaks',
      'Settling tiny disputes',
      'Restoring tiny order',
      'Preventing a conga line',
      'Confiscating the megaphone',
      'Surviving a group hug',
      'Explaining “no”',
      'Supervising nonsense',
    ],
  },
  {
    id: 'questionable-science',
    phrases: [
      'Calibrating shrink rays',
      'Polishing freeze rays',
      'Warming up lasers',
      'Reversing polarity',
      'Tightening strange bolts',
      'Uncrossing wires',
      'Testing red buttons',
      'Adding unnecessary levers',
      'Consulting the manual',
      'Ignoring the manual',
      'Rebooting the toaster',
      'Defusing the coffee maker',
      'Unjamming the gizmo',
      'Feeding the reactor',
      'Borrowing rocket fuel',
      'Reading tiny warnings',
      'Chasing loose electrons',
      'Measuring suspicious goo',
      'Recalibrating reality',
      'Inventing extra buttons',
    ],
  },
  {
    id: 'snacks-paperwork',
    phrases: [
      'Counting bananas',
      'Auditing the snack fund',
      'Rejecting banana bribes',
      'Hiding emergency snacks',
      'Negotiating banana rights',
      'Settling peel disputes',
      'Securing the fruit bowl',
      'Following the banana trail',
      'Filing evil paperwork',
      'Stamping TOP SECRET',
      'Budgeting for lasers',
      'Pricing Moon insurance',
      'Scheduling world domination',
      'Reviewing villain expenses',
      'Updating the evil calendar',
      'Misplacing the clipboard',
      'Shredding rough drafts',
      'Sorting suspicious receipts',
      'Authorizing extra fog',
      'Laminating the master plan',
    ],
  },
  {
    id: 'villainous-flair',
    phrases: [
      'Practicing evil laughter',
      'Revising the monologue',
      'Timing dramatic pauses',
      'Suppressing a cackle',
      'Straightening the scarf',
      'Raising one eyebrow',
      'Swivelling ominously',
      'Muttering “excellent”',
      'Polishing the evil grin',
      'Cueing ominous music',
      'Testing dramatic lighting',
      'Preparing a dramatic exit',
      'Bribing Kyle with snacks',
      'Rescuing the unicorn',
      'Dodging bedtime questions',
      'Practicing a dad joke',
      'Keeping a straight face',
      'Feigning total control',
      'Pretending this was planned',
      'Reconsidering the cape',
    ],
  },
];

export const WORKING_FLAVOR_PHRASES: readonly string[] = WORKING_FLAVOR_CATEGORIES.flatMap(
  (category) => category.phrases,
);

/** In-place Fisher–Yates on a copy; the injected `random` keeps tests
 * deterministic and production on `Math.random`. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

interface Bucket {
  readonly id: string;
  readonly phrases: readonly string[];
  taken: number;
}

export class WorkingFlavorDeck {
  private bag: readonly string[] = [];
  private cursor = 0;
  private lastCategory: string | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /** The next phrase; deals a fresh bag when the current one is spent. */
  next(): string {
    if (this.cursor >= this.bag.length) {
      this.bag = this.deal();
      this.cursor = 0;
    }
    const phrase = this.bag[this.cursor];
    if (phrase === undefined) {
      throw new Error('working flavor deck produced an empty bag');
    }
    this.cursor += 1;
    return phrase;
  }

  /** One bag: shuffled buckets, round-robin interleave, and no category
   * adjacency (which also prevents a repeat across the bag boundary — the
   * previous phrase's category cannot open the next bag). */
  private deal(): readonly string[] {
    const buckets: Bucket[] = WORKING_FLAVOR_CATEGORIES.map((category) => ({
      id: category.id,
      phrases: shuffle(category.phrases, this.random),
      taken: 0,
    }));
    const bag: string[] = [];
    while (bag.length < WORKING_FLAVOR_PHRASES.length) {
      const available = buckets.filter((bucket) => bucket.taken < bucket.phrases.length);
      const order = shuffle(available, this.random);
      if (order.length > 1 && order[0]!.id === this.lastCategory) {
        [order[0], order[1]] = [order[1]!, order[0]!];
      }
      for (const bucket of order) {
        const phrase = bucket.phrases[bucket.taken];
        if (phrase === undefined) {
          throw new Error(`working flavor bucket ${bucket.id} ran empty`);
        }
        bucket.taken += 1;
        bag.push(phrase);
        this.lastCategory = bucket.id;
      }
    }
    return bag;
  }
}
