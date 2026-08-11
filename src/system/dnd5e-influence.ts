// Attitudes and the Influence action, as data.
//
// Two orphaned rules keys from the coverage report — `influence`, `indifferent`/`hostile` — turn out
// to be one rule with a modifier table attached, and both halves are mechanical enough to enforce.
// The 2024 glossary, as mined:
//
//   "The DM then determines whether the monster feels willing, unwilling, or hesitant due to your
//    interaction... If your urging aligns with the monster's desires, no ability check is necessary;
//    the monster fulfills your request in a way it prefers. If your urging is repugnant to the monster
//    or counter to its alignment, no ability check is necessary; it doesn't comply. If you urge the
//    monster to do something that it is hesitant to do, you must make an ability check, which is
//    affected by the monster's attitude: Indifferent, Friendly, or Hostile... The DM chooses the
//    check, which has a default DC equal to 15 or the monster's Intelligence score, whichever is
//    higher. On a successful check, the monster does as urged. On a failed check, you must wait 24
//    hours (or a duration set by the DM) before urging it in the same way again."
//
// And the attitudes themselves, which is the part worth having:
//
//   Friendly    — "You have Advantage on an ability check to influence a Friendly creature."
//   Indifferent — the default attitude of a monster; no adjustment.
//   Hostile     — "You have Disadvantage on an ability check to influence a Hostile creature."
//
// That is a real, checkable rule that nothing in the stack applies, sitting behind a judgement call
// that no software should make. The split this file draws is exactly along that line: the DC, the
// advantage, the skill and the lockout are ours; willing-versus-hesitant-versus-unwilling stays the
// GM's, and is asked rather than guessed.

import { pickNumber, pickString, systemPaths } from "./profiles";
import { hasLanguage } from "../tactics/banter";
import { DC_LADDER } from "./dnd5e-checks";

/** How a creature currently feels about the party. Three values, exactly as the glossary defines. */
export type Attitude = "friendly" | "indifferent" | "hostile";

/** Where an attitude came from, so a card can say why it rolled with Disadvantage. */
export interface AttitudeReading {
  attitude: Attitude;
  /** "set by the GM" | "from the token's disposition" | "the default for a monster". */
  source: string;
}

/**
 * What this creature's attitude is right now.
 *
 * Foundry has no attitude field, and it should not be confused with the one it does have. Token
 * disposition is a canvas concept — it drives border colour, target rings and who counts as an enemy
 * for the encounter layer — whereas attitude is a social stance that can differ from it in both
 * directions: a Hostile-disposition guard captain may be merely Indifferent to a bribe, and a
 * Friendly-disposition shopkeeper may be Hostile to the party that robbed his brother.
 *
 * So disposition is the default and an explicit flag overrules it. The flag is where the GM's ruling
 * lives, and `setAttitude()` is what writes it; nothing infers an attitude from play, because the
 * inputs to that judgement are conversations software never saw.
 */
export function attitudeOf(token: any): AttitudeReading {
  const flagged = readAttitudeFlag(token);
  if (flagged) return { attitude: flagged, source: "set by the GM" };

  const HOSTILE = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;
  const FRIENDLY = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
  const disposition = Number(token?.document?.disposition ?? token?.disposition);

  if (disposition === HOSTILE)
    return { attitude: "hostile", source: "from the token's disposition" };
  if (disposition === FRIENDLY) {
    return { attitude: "friendly", source: "from the token's disposition" };
  }
  // Neutral, Secret, and anything unreadable. "Indifferent is the default attitude of a monster",
  // and Secret is GM bookkeeping rather than a stance, so it lands here correctly.
  return { attitude: "indifferent", source: "the default for a monster" };
}

/** The attitude a GM has pinned on this token, if any. Read through both flag namespaces. */
function readAttitudeFlag(token: any): Attitude | null {
  const doc = token?.document ?? token;
  for (const scope of ["noodlr-hooks-55e", "noodlr"]) {
    let raw: unknown;
    try {
      raw = doc?.getFlag?.(scope, "attitude") ?? doc?.flags?.[scope]?.attitude;
    } catch {
      raw = doc?.flags?.[scope]?.attitude;
    }
    const value = String(raw ?? "").toLowerCase();
    if (value === "friendly" || value === "indifferent" || value === "hostile") return value;
  }
  return null;
}

/**
 * The default DC to influence this creature: "15 or the monster's Intelligence score, whichever is
 * higher".
 *
 * Reading the SCORE and not the modifier, the same trap as the long jump. An Intelligence 20 lich is
 * DC 20 to sway and a Strength-brute ogre with Intelligence 5 is still DC 15, because the rule is a
 * floor rather than a scale. An unreadable sheet falls back to the floor, which is the answer a GM
 * would give anyway.
 */
export function influenceDc(actor: any): number {
  const intelligence = pickNumber(actor, systemPaths().intelligence);
  if (intelligence === null) return DC_LADDER.medium;
  return Math.max(DC_LADDER.medium, Math.round(intelligence));
}

/** One way of leaning on somebody, and the check it is rolled with. */
export interface Approach {
  /** The behavior verb this maps to, so an AI listener can play the attempt out. */
  verb: "PERSUADE" | "DECEIVE" | "INTIMIDATE" | "PARLEY" | "BRIBE";
  /** The system's skill id. */
  skill: string;
  label: string;
  /** True when the target has to understand what is being said to it. */
  needsSpeech: boolean;
  /** True when this only works on a Beast or Monstrosity. */
  beastsOnly: boolean;
}

/**
 * The five approaches the glossary tabulates, plus the verbs they hand to a narrator.
 *
 * The rulebook lists the checks and leaves the choice to the DM ("The DM chooses the check"). Naming
 * them here does not take that away — an approach is offered, not imposed, and the GM entry point
 * accepts any skill id. What it buys is the two gates underneath, which are mechanical and are
 * constantly forgotten at the table: you cannot persuade or deceive something that does not
 * understand a word you are saying, and Animal Handling is for Beasts and Monstrosities.
 *
 * These are also the first triggers for four of the behavior verbs that have been declared in the
 * contract with nothing firing them. Intimidating a guard now actually reaches a listener.
 */
export const APPROACHES: Record<string, Approach> = {
  persuade: {
    verb: "PERSUADE",
    skill: "per",
    label: "Persuasion",
    needsSpeech: true,
    beastsOnly: false,
  },
  deceive: {
    verb: "DECEIVE",
    skill: "dec",
    label: "Deception",
    needsSpeech: true,
    beastsOnly: false,
  },
  intimidate: {
    verb: "INTIMIDATE",
    skill: "itm",
    label: "Intimidation",
    // Deliberately false. A drawn blade and a raised voice carry perfectly well to something that
    // speaks no Common, which is why the glossary's line is "Intimidating a monster" with no
    // "that understands you" qualifier, unlike Persuasion's and Deception's.
    needsSpeech: false,
    beastsOnly: false,
  },
  amuse: {
    verb: "PARLEY",
    skill: "prf",
    label: "Performance",
    needsSpeech: false,
    beastsOnly: false,
  },
  coax: {
    verb: "PARLEY",
    skill: "ani",
    label: "Animal Handling",
    needsSpeech: false,
    beastsOnly: true,
  },
  bribe: {
    // Not one of the tabulated five. Bribery is Persuasion with something on the table, and it earns
    // its own entry only because the contract has a BRIBE verb and a listener should hear the
    // difference between an offer and an argument.
    verb: "BRIBE",
    skill: "per",
    label: "Persuasion (a bribe)",
    needsSpeech: true,
    beastsOnly: false,
  },
};

/** Whether an approach can even be attempted on this creature, and why not when it cannot. */
export function approachApplies(approach: Approach, target: any): { ok: boolean; reason: string } {
  if (approach.needsSpeech && !hasLanguage(target)) {
    return { ok: false, reason: "it does not understand a word you are saying" };
  }
  if (approach.beastsOnly && !isCoaxable(target)) {
    return { ok: false, reason: "coaxing works on Beasts and Monstrosities" };
  }
  return { ok: true, reason: "" };
}

/** Beast or Monstrosity, which is the population Animal Handling covers. */
export function isCoaxable(actor: any): boolean {
  const type = pickString(actor, systemPaths().creatureType).toLowerCase();
  return type.includes("beast") || type.includes("monstrosity");
}

/**
 * How the attitude bends the roll.
 *
 * The whole mechanical content of the three attitude entries, and the reason this rule was worth
 * building rather than leaving to the GM: everybody remembers that a hostile creature is harder to
 * talk round, and nobody remembers to actually roll it with Disadvantage.
 */
export function attitudeSwing(attitude: Attitude): {
  advantage: boolean;
  disadvantage: boolean;
} {
  return {
    advantage: attitude === "friendly",
    disadvantage: attitude === "hostile",
  };
}
