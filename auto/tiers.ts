// Nine tiers of tactical competence, keyed to (INT + WIS) / 2.
//
// The point of the ladder is NOT to make clever monsters. It is to make monsters that are wrong in
// the ways their sheet says they should be wrong. An owlbear that flanks the wizard and saves its
// breath weapon for the cleric is a worse encounter than one that mauls whatever hurt it last, even
// though the owlbear "played better". So competence is modelled as two separate dials:
//
//   1. WHICH considerations a creature is even capable of having (this file's `unlocks`), and
//   2. HOW RELIABLY it acts on them (`noise` — see the planner's weighted choice).
//
// A tier-1 creature is not a tier-9 creature with fewer options; it is a creature that cannot
// conceive of most options AND frequently fumbles the ones it has. Both dials matter: gating alone
// produces a stupid creature that plays its two options perfectly, which reads as eerily precise.
//
// Thresholds and descriptors come from the user's table (2026-08-02). Everything above tier 6 is
// honest about its own limits — see TIER_CAVEAT at the bottom.

/** A named capability the planner checks before it will even score an option. */
export type Consideration =
  // --- Tier 1: it can act at all -------------------------------------------------------------
  /** Use its main attack, bonus attack, innate/special features, and spell-likes on someone. */
  | "basicAttacks"
  /** Bellow for help — alerts allies, no mechanical target selection behind it. */
  | "callForHelp"
  // --- Tier 2: crude target preference --------------------------------------------------------
  /** Pick on whoever LOOKS weakest (smallest/lowest apparent stature), not whoever is weakest. */
  | "targetApparentWeakest"
  // --- Tier 3: self-preservation --------------------------------------------------------------
  /** Back away from opponents that have hurt it badly. */
  | "avoidStrongOpponents"
  /** Use carried items at all (thrown flask, caltrops, a wand it happens to hold). */
  | "useInventory"
  /** Break off and run when badly wounded. */
  | "fleeWhenHurt"
  // --- Tier 4: it knows the rules apply to it too ---------------------------------------------
  /** Hide, break line of sight, use cover deliberately. */
  | "stealth"
  /** Feint, bluff, misdirect — anything the system models as a deception-style action. */
  | "deception"
  /** Disarm, shove, grapple, trip: mechanical options that are not damage. */
  | "controlManeuvers"
  /** Drink the potion, cast the heal on itself. */
  | "selfHealing"
  /** Shoot from where the melee cannot reach, and back off when something closes. */
  | "keepDistance"
  /** Finish the turn behind something solid rather than in the open. */
  | "seekCover"
  // --- Tier 5: it has friends ------------------------------------------------------------------
  /** Heal, buff, or otherwise spend a turn improving an ally instead of itself. */
  | "supportAllies"
  /** Step between a wounded ally and the threat; take the hit. */
  | "protectAllies"
  // --- Tier 6: it reads the battlefield ---------------------------------------------------------
  /** Identify the real damage dealers (casters, artillery) and go for them. */
  | "targetHighestThreat"
  /** Concentrate fire with allies rather than spreading damage. */
  | "focusFire"
  // --- Tier 7: it plans past this turn ----------------------------------------------------------
  /** Withdraw toward terrain that favors it, or bait pursuit into a bad place. */
  | "repositionForAdvantage"
  /** Hold an action or resource for a predicted opening instead of spending it now. */
  | "holdResources"
  // --- Tier 8: it plays the people, not the fight ------------------------------------------------
  /** Charm, dominate, curse, bribe — turn the party's own resources against it. */
  | "manipulateEnemies"
  /** Deliberately bleed the party's consumables and spell slots. */
  | "resourceDenial"
  // --- Tier 9: it was never really about this fight ----------------------------------------------
  /** Accept a local loss for a gain the party will not understand until much later. */
  | "longGame";

export interface TierProfile {
  tier: number;
  /** Human label from the user's table; shown in the GM-facing log line. */
  descriptor: string;
  /** Everything this creature can consider, cumulative up the ladder. */
  unlocks: Consideration[];
  /**
   * How much randomness is mixed into the choice, 0 (always takes its best-scored option) to 1
   * (barely correlated with the score). This is what makes a dull-witted creature *act* dull rather
   * than merely act limited.
   */
  noise: number;
  /**
   * How many options it bothers to weigh. A beast lunges at the first workable thing it notices; a
   * genius surveys the board. Also the CPU ceiling per turn, which is the point of capping it.
   */
  breadth: number;
}

// Each tier inherits the previous tier's unlocks; only the additions are listed here.
const LADDER: Array<{ descriptor: string; adds: Consideration[]; noise: number; breadth: number }> =
  [
    {
      descriptor: "Insect-level intellect",
      adds: ["basicAttacks", "callForHelp"],
      noise: 0.85,
      breadth: 2,
    },
    {
      descriptor: "Animal instincts only",
      adds: ["targetApparentWeakest"],
      noise: 0.7,
      breadth: 3,
    },
    {
      descriptor: "Child-like",
      adds: ["avoidStrongOpponents", "useInventory", "fleeWhenHurt"],
      noise: 0.55,
      breadth: 4,
    },
    {
      descriptor: "Average intellect",
      adds: [
        "stealth",
        "deception",
        "controlManeuvers",
        "selfHealing",
        "keepDistance",
        "seekCover",
      ],
      noise: 0.45,
      // Two more things to weigh than the tier had before the 2026-08-02 revision.
      breadth: 7,
    },
    {
      descriptor: "Veteran / skilled professional",
      adds: ["supportAllies", "protectAllies"],
      noise: 0.35,
      breadth: 8,
    },
    {
      descriptor: "Above-average intellect",
      adds: ["targetHighestThreat", "focusFire"],
      noise: 0.25,
      breadth: 10,
    },
    {
      descriptor: "Genius",
      adds: ["repositionForAdvantage", "holdResources"],
      noise: 0.18,
      breadth: 12,
    },
    {
      descriptor: "Alien intellect",
      adds: ["manipulateEnemies", "resourceDenial"],
      noise: 0.12,
      breadth: 14,
    },
    { descriptor: "God-like", adds: ["longGame"], noise: 0.08, breadth: 16 },
  ];

const PROFILES: TierProfile[] = LADDER.map((entry, i) => ({
  tier: i + 1,
  descriptor: entry.descriptor,
  unlocks: LADDER.slice(0, i + 1).flatMap((e) => e.adds),
  noise: entry.noise,
  breadth: entry.breadth,
}));

/** Thresholds from the user's table: the tier is the first band the score falls into. */
export function tierForScore(mental: number): number {
  if (mental < 3) return 1;
  if (mental <= 5) return 2;
  if (mental <= 8) return 3;
  if (mental <= 11) return 4;
  if (mental <= 14) return 5;
  if (mental <= 17) return 6;
  if (mental <= 20) return 7;
  if (mental <= 23) return 8;
  return 9;
}

export function tierProfile(tier: number): TierProfile {
  const clamped = Math.max(1, Math.min(9, Math.round(tier)));
  return PROFILES[clamped - 1];
}

/**
 * (INT + WIS) / 2 for a creature, or null when the sheet doesn't report both. A missing score is not
 * treated as zero — an unreadable sheet becoming an insect is a worse failure than defaulting to the
 * middle of the ladder, which is what the caller should do.
 */
export function mentalScore(intelligence: number | null, wisdom: number | null): number | null {
  if (intelligence === null || wisdom === null) return null;
  return (intelligence + wisdom) / 2;
}

export function can(profile: TierProfile, consideration: Consideration): boolean {
  return profile.unlocks.includes(consideration);
}

/**
 * Where the ladder stops being honest. Tiers 1-6 describe things a turn-by-turn planner can actually
 * do: pick targets, move, spend resources, protect an ally. Tier 7 is already stretching — "bait them
 * into the trap room" needs authored terrain the planner cannot invent. Tiers 8 and 9 (manipulation,
 * generational scheming) are campaign-scale fiction, not combat mechanics: no per-turn automaton
 * plays a decades-long con. What those tiers get instead is the best of what IS mechanical (control
 * effects, resource denial, patient withdrawal) plus GM-facing hints, and the LLM narrator to voice
 * the intent. Anything more would be pretending.
 */
export const TIER_CAVEAT = 7;
