// The numbers the general rules turn on, quarantined the same way every other D&D name in this
// module is.
//
// This is the third file in `system/` that exists purely as a table — after the concealment and the
// forced-movement tables — and for the same reason: `rules/` is allowed to know that a jump has a
// distance, and is never allowed to know that the distance is a Strength score. Porting to another
// game system means writing a sibling that exports these same functions, not editing `rules/`.
//
// What lives here is the finite set of general rules identified in the corpus coverage report: the
// ones that read the same for every creature in every campaign, which is exactly why they are
// hard-coded rather than compiled off a sheet. Each is quoted from the 2024 rules glossary as it was
// mined, so nobody has to go and look it up again to check the arithmetic.

import { pickNumber, systemPaths } from "./profiles";
import { isDnd5e } from "./dnd5e-rewards";
import { jumpProfile } from "./dnd5e-jump";
import { rulesVersion } from "./dnd5e-stealth";

/**
 * Typical DCs, from the 2024 rules glossary.
 *
 * Pure reference data with no engine behind it, and that is the whole finding: `difficultyclass` came
 * out of the coverage report as an orphaned rules key, but a table of six numbers a GM picks from is
 * not something software can apply on anyone's behalf. It is here so the module's own DCs can be
 * named rather than typed as bare integers, and so `api.surveyGeneralRules()` can print it when
 * somebody asks what the module thinks a Hard check is.
 */
export const DC_LADDER = {
  veryEasy: 5,
  easy: 10,
  medium: 15,
  hard: 20,
  veryHard: 25,
  nearlyImpossible: 30,
} as const;

export type DifficultyBand = keyof typeof DC_LADDER;

/** The band a DC falls in, for a chat card that would rather say "Hard" than "20". */
export function difficultyBand(dc: number): DifficultyBand {
  const bands = Object.entries(DC_LADDER) as Array<[DifficultyBand, number]>;
  let best: DifficultyBand = "veryEasy";
  for (const [band, value] of bands) if (dc >= value) best = band;
  return best;
}

/**
 * How far a creature must move on foot immediately before a jump to get the running distance.
 *
 * Ten feet in both editions. Expressed in the scene's own units nowhere — this is a rules constant in
 * feet, and a table playing in metres has already accepted that its scene units and its rulebook
 * disagree. Converting would be inventing a rule.
 */
export const JUMP_RUN_UP = 10;

export interface JumpDistances {
  /** Long Jump with the run-up: a number of feet up to the creature's Strength SCORE. */
  longRunning: number;
  /** Standing Long Jump: half that. */
  longStanding: number;
  /** High Jump with the run-up: 3 plus the Strength MODIFIER, minimum 0. */
  highRunning: number;
  /** Standing High Jump: half that. */
  highStanding: number;
  /** True when neither number could be read off the sheet and both are guesses of zero. */
  unreadable: boolean;
  /** Features that changed these numbers, named for the card and the diagnostics. */
  modifiers: string[];
}

export interface JumpOptions {
  /**
   * Whether the turn-scoped doubling is running — Step of the Wind, and anything else a rules layer
   * decides has doubled this creature's jump for the turn.
   *
   * Passed in rather than read here on purpose: everything else in this file is a fact about a sheet
   * and can be answered from the actor alone, while "was a Focus Point spent this turn" is turn
   * ledger state that belongs with the rest of the turn's bookkeeping. A system table that reached
   * for the combat round would stop being a table.
   */
  doubled?: boolean;
}

/**
 * What this creature can clear, from the 2024 Long Jump and High Jump entries verbatim:
 *
 *   "When you make a Long Jump, you leap horizontally a number of feet up to your Strength score if
 *    you move at least 10 feet immediately before the jump. When you make a standing Long Jump, you
 *    can leap only half that distance."
 *
 *   "When you make a High Jump, you leap into the air a number of feet equal to 3 plus your Strength
 *    modifier (minimum of 0 feet) if you move at least 10 feet on foot immediately before the jump.
 *    When you make a standing High Jump, you can jump only half that distance."
 *
 * Note which ability figure each one uses. The long jump is the SCORE — a Strength 16 fighter clears
 * sixteen feet — and the high jump is the MODIFIER. Getting those the wrong way round is the single
 * most common mistake with this rule and produces numbers that look plausible, so it is spelled out
 * here rather than left to the reader of the arithmetic.
 *
 * **Deliberately not read from `system.attributes.movement.jump`.** dnd5e does populate that field,
 * as `str.value / 2` (`data/actor/templates/attributes.mjs:456` in 5.3.3), which is the STANDING long
 * jump and only that. It exists to colour the drag ruler while the jump movement action is selected.
 * Reading it would silently halve every running jump and would have no answer at all for the high
 * jump, so the ability figures are read directly.
 *
 * **The general rule is only the starting point.** Whatever `jumpProfile()` found on the sheet is
 * applied on top: a different ability, a flat bonus, a multiplier, or a stated distance that replaces
 * the calculation outright. That layer exists because a veto built on the bare rule refuses legal
 * leaps — a bullywug's Standing Leap is 20 feet against a Strength 12, so every jump it ever made was
 * blocked with a confident and wrong number. See `dnd5e-jump.ts`.
 */
export function jumpDistances(actor: any, options: JumpOptions = {}): JumpDistances {
  const P = systemPaths();
  const profile = jumpProfile(actor);

  const scorePaths = profile.ability === "dex" ? P.dexterity : P.strength;
  const modPaths = profile.ability === "dex" ? P.dexterityMod : P.strengthMod;
  const score = pickNumber(actor, scorePaths);
  const stated = pickNumber(actor, modPaths);
  const modifier = stated ?? (score === null ? null : Math.floor((score - 10) / 2));

  // A stated distance stands on its own, so a creature whose ability scores are unreadable but whose
  // trait says "Long Jump is up to 20 feet" still gets a number. Only the case where NOTHING is
  // readable is a genuine unreadable.
  const hasStated =
    profile.fixedLong !== null || profile.fixedHigh !== null || profile.fixedRunningLong !== null;
  if (score === null && modifier === null && !hasStated) {
    return {
      longRunning: 0,
      longStanding: 0,
      highRunning: 0,
      highStanding: 0,
      unreadable: true,
      modifiers: profile.sources,
    };
  }

  const multiplier = profile.multiplier * (options.doubled ? 2 : 1);
  const scale = (feet: number) => Math.floor(Math.max(0, feet + profile.bonus) * multiplier);

  const baseLong = Math.max(0, score ?? 0);
  const baseHigh = Math.max(0, 3 + (modifier ?? 0));

  // Halved distances round down: half of a Strength 15's fifteen feet is seven, not seven and a half,
  // because the grid has no half squares and the rules round down everywhere else. Halving happens
  // BEFORE the bonus and the multiplier — Step of the Wind doubles the jump the creature is making,
  // not the score it derives from.
  const longRunning = scale(profile.fixedLong ?? profile.fixedRunningLong ?? baseLong);
  const highRunning = scale(profile.fixedHigh ?? baseHigh);
  let longStanding = scale(profile.fixedLong ?? Math.floor(baseLong / 2));
  let highStanding = scale(profile.fixedHigh ?? Math.floor(baseHigh / 2));

  // "with or without a running start": the trait's whole point is that standing costs nothing, and
  // it holds even when no distance could be parsed out of the prose. That half needs no arithmetic
  // and is the half that fixes the common false refusal.
  if (profile.noRunUp) {
    longStanding = Math.max(longStanding, longRunning);
    highStanding = Math.max(highStanding, highRunning);
  }

  return {
    longRunning,
    longStanding,
    highRunning,
    highStanding,
    unreadable: false,
    modifiers: profile.sources,
  };
}

/**
 * The DC to stabilise a dying creature by hand, and the skill it is rolled with.
 *
 * 2024 calls this Administer First Aid and files it under the Utilize action: "DC 10 Wisdom
 * (Medicine) check to stabilize a creature that has 0 Hit Points". 2014 words it as a Wisdom
 * (Medicine) check against DC 10 too, so there is no edition split to carry here.
 */
export function firstAidDc(): { dc: number; skill: string } {
  return { dc: DC_LADDER.easy, skill: "med" };
}

/**
 * The published object statistics, as reference data only.
 *
 * `breakingobjects` was the other orphaned key worth checking, and the answer is that the mechanical
 * half of it is already enforced by somebody: dnd5e applies a damage threshold in
 * `documents/actor/actor.mjs:883` for any actor carrying `system.attributes.hp.dt`, and this module's
 * dying layer already handles the drop to zero. What is left — whether the tavern door has 15 hit
 * points, whether smashing a leg collapses the table — is the two things software cannot supply: a
 * statblock for scenery Foundry does not model as a document, and a GM's judgement.
 *
 * So this table is printed on request and applied to nothing. That is not a gap left open by
 * accident; it is the honest answer, and writing an engine that guessed at an object's hit points
 * would be worse than not having one.
 */
export const OBJECT_REFERENCE = {
  armorClass: {
    cloth: 11,
    paper: 11,
    rope: 11,
    crystal: 13,
    glass: 13,
    ice: 13,
    wood: 15,
    bone: 15,
    stone: 17,
    iron: 19,
    steel: 19,
    mithral: 21,
    adamantine: 23,
  },
  hitPoints: {
    /** Fragile / Resilient, by size, as the 2024 Objects table gives them. */
    tinyFragile: 2,
    tinyResilient: 5,
    smallFragile: 3,
    smallResilient: 10,
    mediumFragile: 4,
    mediumResilient: 18,
    largeFragile: 5,
    largeResilient: 27,
  },
  /** Objects are immune to these outright, whatever their hit points say. */
  immunities: ["poison", "psychic"],
} as const;

/**
 * Is the 5e general-rules layer applicable at all?
 *
 * Same gate as every other file in this folder. Everything here is quoted from one game's rulebook,
 * so on any other system these functions must decline rather than produce a number.
 */
export function generalRulesApply(): boolean {
  return isDnd5e();
}

/** Which edition's wording the numbers above are being read under. Re-exported for one import. */
export { rulesVersion };
