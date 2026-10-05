/**
 * Working-state flavor copy: the original 100 phrases (owner-approved
 * 2026-10-01, `GRU-WORKING-FLAVOR-20261001`) plus 100 additions
 * (owner-approved 2026-10-03, twenty per category) — 200 in all.
 *
 * While the authoritative chat context is connected and `busy`, the status
 * chip rotates one of these phrases every `WORKING_FLAVOR_INTERVAL_MS`.
 * The copy is decoration for one real local state: it is never progress,
 * instructions, job events, or model output, and it must never drive
 * anything but that chip's text.
 *
 * `WorkingFlavorDeck` owns the shuffle contract:
 *   - each bag is a permutation of all 200 approved phrases (nothing
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
 * the approval. Each category's first twenty entries are the original
 * 2026-10-01 copy, pinned on its own; the whole 200-phrase pool is pinned
 * separately, so edits require an owner-approved copy change plus explicit
 * pin updates.
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
      'Alphabetising evil plans',
      'Rehearsing an innocent whistle',
      'Scouting the aquarium',
      'Mapping the air vents',
      'Sketching secret tunnels',
      'Synchronizing watches',
      'Memorising the guard rota',
      'Picking the codename',
      'Designing a better trapdoor',
      'Auditioning accomplices',
      'Conniving politely',
      'Rethinking the entire plan',
      'Casing the museum',
      'Erasing the footprints',
      'Renting a stealth blimp',
      'Buffing the grappling hook',
      'Buying suspicious rope',
      'Choosing escape music',
      'Mastering sneaky footsteps',
      'Scheduling the moon grab',
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
      'Giving Kevin a decoy button',
      'Moderating the group chat',
      'Issuing tiny name badges',
      'Assigning buddy minions',
      'Holding a safety briefing',
      'Peeling a minion off the wall',
      'Teaching Stuart to knock',
      'Enforcing nap time',
      'Welcoming the newest minion',
      'Updating the chore wheel',
      'Vacuuming up the glitter',
      'Hosting a talent show',
      'Arranging tiny vacations',
      'Leading the team chant',
      'Rescuing a lost goggle',
      'Breaking up a tiny mutiny',
      'Interviewing tiny applicants',
      'Wiping tiny fingerprints',
      'Rebuilding the pillow fort',
      'Handing out juice boxes',
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
      'Untangling the laser spaghetti',
      'Rebuilding the ray gun',
      'Unplugging the angry vacuum',
      'Soothing a grumpy robot',
      'Chasing a runaway invention',
      'Installing a lab disco ball',
      'Rewiring the doorbell',
      'Bolting on rocket cupholders',
      'Explaining the small explosion',
      'Mislabelling the big button',
      'Calibrating the banana scale',
      'Magnetising the cutlery',
      'Freezing a banana for science',
      'Apologizing to the test dummy',
      'Christening the new laser',
      'Brewing a new isotope',
      'Testing the mood ray',
      'Teaching the toaster to sing',
      'Assembling a helper robot',
      'Arguing with the lab computer',
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
      'Changing the snack vault code',
      'Guarding the cookie jar',
      'Stapling the fine print',
      'Colour-coding the folders',
      'Ordering extra paperclips',
      'Sharpening the evil pencils',
      'Filing under “later”',
      'Invoicing the Moon',
      'Balancing the banana ledger',
      'Protecting the good stapler',
      'Postponing the audit',
      'Recycling last week’s memos',
      'Watering the office plant',
      'Bubble-wrapping the snacks',
      'Reserving the lair’s ballroom',
      'Pinning up the snack rota',
      'Taking villain meeting minutes',
      'Shipping a crate of bananas',
      'Rewriting the snack policy',
      'Rationing the jelly beans',
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
      'Blaming a suspicious penguin',
      'Nailing the slow clap',
      'Summoning a little thunder',
      'Dry-cleaning the cape',
      'Sampling entrance songs',
      'Dusting the skull mug',
      'Talking to the evil fern',
      'Petting a fluffy cat',
      'Checking the evil echo',
      'Naming the secret lair',
      'Humming the evil theme',
      'Booking a dramatic sunset',
      'Delivering a wicked one-liner',
      'Tidying up for the heroes',
      'Rereading the villain handbook',
      'Reclining dramatically',
      'Starting the wind machine',
      'Nodding slowly',
      'Slurping ominously',
      'Curating the lair playlist',
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
