// What changes a creature's jump distance. D&D 5e ONLY.
//
// SYSTEM-SPECIFIC BY NECESSITY, quarantined like the rider, declaration, Dash and concealment tables.
// `rules/jump.ts` is allowed to know that a leap has a limit; it is never allowed to know that the
// limit is a Strength score, or that a lion has Running Leap.
//
// WHY THIS EXISTS. `jumpDistances()` read Strength and nothing else, and `jumpVeto()` turns that into a
// refusal — so every creature whose sheet says otherwise was told it could not make a jump the rules
// plainly allow. A bullywug's Standing Leap is 20 feet with no run-up and its Strength is 12, so the cap
// was 12 running and 6 standing and EVERY legal leap it made was blocked. Same for a monk spending a
// Focus Point, a rogue with Second-Story Work, and a cat.
//
// That is the worst failure this module has: a false refusal, arriving as a message that confidently
// states a wrong number. Everything below is therefore biased the other way — an unreadable or
// unparseable feature widens the allowance or leaves it alone, and never narrows it.
//
// FIVE SHAPES, all read off the corpus rather than remembered (2026-08-13, 46 atoms across nine books):
//
//   ability substitution  Jumper, Second-Story Work — "determined using its Dexterity rather than
//                         its Strength". No number to parse.
//   flat bonus            Peerless Athlete — "the distance of your Long and High Jumps increases by
//                         10 feet". Activated, so it must be running rather than merely owned.
//   multiplier            Step of the Wind — "your jump distance is doubled for the turn". Turn-scoped,
//                         which is why the marker lives in `rules/jump.ts` and not here.
//   fixed, no run-up      Standing Leap — "the frog's Long Jump is up to 10 feet and its High Jump is
//                         up to 5 feet with or without a running start". The numbers vary per creature
//                         and exist only in the prose.
//   fixed, with a run-up  Running Leap — "With a 10-foot running start, the lion can Long Jump up to
//                         25 feet". Long jump only; the high jump is untouched.
//
// PROSE PARSING IS DELIBERATE AND IS BIASED. Standing Leap and Running Leap state their distances
// nowhere but the description, exactly as Multiattack states its attack count nowhere but the
// description, and the same doctrine applies: parse it, and when the parse fails take the reading that
// cannot refuse a legal action. For Standing Leap that means the "with or without a running start"
// clause is honoured even when no number is found — the standing distances simply become the running
// ones, which is the half of the trait that fixes the common failure and needs no arithmetic at all.

import { readFlag } from "../util/flags";
import { isActionActivity, type ActionSpec } from "./dnd5e-actions";
import { isDnd5e } from "./dnd5e-rewards";

export type JumpAbility = "str" | "dex";

/** Everything the sheet says about how far this creature jumps, before the general rule is applied. */
export interface JumpProfile {
  /** Which ability figure the distances are derived from. */
  ability: JumpAbility;
  /** Feet added to both the Long and the High Jump. */
  bonus: number;
  /** Applied after the bonus, to both. */
  multiplier: number;
  /** A stated Long Jump that replaces the calculation, in feet. */
  fixedLong: number | null;
  /** A stated High Jump that replaces the calculation, in feet. */
  fixedHigh: number | null;
  /** A stated Long Jump that applies only with the run-up, in feet. */
  fixedRunningLong: number | null;
  /** True when this creature jumps its full distance from standing. */
  noRunUp: boolean;
  /** Feature names that contributed, for the card and the diagnostics. */
  sources: string[];
}

/** No feature found: the general rule, unmodified. */
export function plainJumpProfile(): JumpProfile {
  return {
    ability: "str",
    bonus: 0,
    multiplier: 1,
    fixedLong: null,
    fixedHigh: null,
    fixedRunningLong: null,
    noRunUp: false,
    sources: [],
  };
}

interface JumpFeature {
  label: string;
  /** `system.identifier` values, which are stable across dnd5e versions and localisations. */
  identifiers?: string[];
  /** Matched against item and effect names when no identifier is stated. */
  pattern?: RegExp;
  /** Read the distances off Dexterity instead of Strength. */
  ability?: JumpAbility;
  /** Feet added to both jumps. */
  bonus?: number;
  /** True when owning the feature grants nothing and an effect of the same name must be running. */
  effectOnly?: boolean;
}

/**
 * Features whose effect is a fixed rule, needing nothing parsed out of their prose.
 *
 * Step of the Wind is deliberately absent. Its doubling lasts one turn and only once a Focus Point has
 * actually been spent, so `monks-focus` on the sheet proves nothing — a monk owns that feature from
 * level 2 and jumps normally most turns. The marker that says it was used this turn is turn-scoped
 * state, which belongs with the rest of the turn ledger rather than in a table of sheet facts.
 */
const FEATURES: JumpFeature[] = [
  {
    // The monster trait and the rogue's level-3 Thief feature word the same rule differently and share
    // no identifier, so both are listed. Second-Story Work also negates falling damage, which is not
    // modelled here because Foundry has no concept of falling at all.
    label: "Jumper",
    identifiers: ["jumper"],
    pattern: /^\s*jumper\s*$/i,
    ability: "dex",
  },
  {
    label: "Second-Story Work",
    identifiers: ["second-story-work"],
    pattern: /second[-\s]story\s*work/i,
    ability: "dex",
  },
  {
    // Oath of Glory's Channel Divinity, in both the PHB and Tasha's spellings. `effectOnly` because it
    // lasts an hour from the moment it is invoked: a paladin who has never used it jumps normally, and
    // reading the owned feature would give them ten free feet all day.
    label: "Peerless Athlete",
    identifiers: ["peerless-athlete", "channel-divinity-peerless-athlete"],
    pattern: /peerless\s*athlete/i,
    bonus: 10,
    effectOnly: true,
  },
];

/** "with or without a running start" — the clause that makes a standing jump a full one. */
const NO_RUN_UP = /with or without a running start/i;

/** "its Long Jump is up to 20 feet" / "your long jump is up to 30 feet". */
const STATED_LONG = /long jump is up to (\d+)\s*(?:feet|foot|ft)/i;
const STATED_HIGH = /high jump is up to (\d+)\s*(?:feet|foot|ft)/i;

/**
 * "With a 10-foot running start, the lion can Long Jump up to 25 feet."
 *
 * Order-sensitive on purpose: Standing Leap's wording also contains "running start", but there it comes
 * AFTER the distances, so requiring the phrase first is what keeps the two traits apart without either
 * needing to know about the other.
 */
const STATED_RUNNING_LONG = /running start[^.]{0,80}?long jump up to (\d+)\s*(?:feet|foot|ft)/i;

function proseOf(item: any): string {
  const raw =
    String(item?.system?.description?.value ?? "") +
    " " +
    String(item?.system?.description?.chat ?? "");
  return raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

function identifierOf(item: any): string {
  return String(item?.system?.identifier ?? "")
    .trim()
    .toLowerCase();
}

function nameOf(entry: any): string {
  return String(entry?.name ?? "").trim();
}

function matches(feature: JumpFeature, item: any): boolean {
  const identifier = identifierOf(item);
  if (identifier && feature.identifiers?.includes(identifier)) return true;
  // Only when the sheet states no identifier, so a world that deliberately re-identified a feature is
  // not overruled by what it happens to be called. Same discipline as the Dash and rider tables.
  return Boolean(!identifier && feature.pattern?.test(nameOf(item)));
}

/**
 * What this creature's own sheet says about jumping.
 *
 * Reads items for the named features and for the two prose-stated traits, and active effects for the
 * activated ones. Returns the plain profile on any other game system, so `dnd5e-checks.ts` can consult
 * it unconditionally.
 */
export function jumpProfile(actor: any): JumpProfile {
  const profile = plainJumpProfile();
  if (!isDnd5e() || !actor) return profile;

  // The escape hatches, ahead of everything: an Active Effect writing one of these needs no entry in
  // any table here, which is what makes a feature nobody has heard of expressible today.
  const ability = String(readFlag(actor, "jumpAbility") ?? "").toLowerCase();
  if (ability === "dex" || ability === "str") {
    profile.ability = ability;
    profile.sources.push(`flags.*.jumpAbility (${ability})`);
  }
  const bonus = Number(readFlag(actor, "jumpBonus"));
  if (Number.isFinite(bonus) && bonus !== 0) {
    profile.bonus += bonus;
    profile.sources.push(`flags.*.jumpBonus (${bonus})`);
  }
  const multiplier = Number(readFlag(actor, "jumpMultiplier"));
  if (Number.isFinite(multiplier) && multiplier > 0 && multiplier !== 1) {
    profile.multiplier *= multiplier;
    profile.sources.push(`flags.*.jumpMultiplier (${multiplier})`);
  }

  const effectNames: string[] = [];
  for (const effect of actor?.appliedEffects ?? actor?.effects ?? []) {
    const name = nameOf(effect);
    if (name) effectNames.push(name);
  }

  const items: any[] = Array.from(actor?.items ?? []);

  for (const feature of FEATURES) {
    const running = Boolean(feature.pattern && effectNames.some((n) => feature.pattern!.test(n)));
    const owned = !feature.effectOnly && items.some((item) => matches(feature, item));
    if (!running && !owned) continue;

    if (feature.ability) profile.ability = feature.ability;
    if (feature.bonus) profile.bonus += feature.bonus;
    profile.sources.push(feature.label);
  }

  // The two prose-stated traits. Recognised by the clause rather than by a list of identifiers, because
  // the same sentence turns up on a magic item ("Vomerine Tooth of a Large Toad") that no table of
  // creature traits would ever have caught, and the phrase is specific enough that a false positive
  // would have to be an item whose description quotes a monster trait verbatim.
  for (const item of items) {
    const prose = proseOf(item);
    if (!/jump/i.test(prose)) continue;

    if (NO_RUN_UP.test(prose)) {
      profile.noRunUp = true;
      const long = STATED_LONG.exec(prose);
      const high = STATED_HIGH.exec(prose);
      if (long) profile.fixedLong = Math.max(profile.fixedLong ?? 0, Number(long[1]));
      if (high) profile.fixedHigh = Math.max(profile.fixedHigh ?? 0, Number(high[1]));
      profile.sources.push(nameOf(item) || "a stated jump distance");
      continue;
    }

    const runningLong = STATED_RUNNING_LONG.exec(prose);
    if (runningLong) {
      profile.fixedRunningLong = Math.max(profile.fixedRunningLong ?? 0, Number(runningLong[1]));
      profile.sources.push(nameOf(item) || "a stated running jump");
    }
  }

  return profile;
}

/**
 * Step of the Wind, which doubles the jump "for the turn" once a Focus Point has been spent.
 *
 * Recognised as an activity rather than read off the sheet, and that is the whole distinction between
 * this and everything in `FEATURES`: a monk owns Monk's Focus from level 2 and jumps normally on most
 * turns, so the feature's presence proves nothing. Only pressing it does.
 *
 * 2024 folds it into Monk's Focus as a named activity; 2014 has it as its own feature under Ki. Both
 * routes are covered by the shared recogniser — the activity name catches the first, the identifier
 * the second.
 */
export const STEP_OF_THE_WIND: ActionSpec = {
  id: "step-of-the-wind",
  name: /step\s*of\s*the\s*wind/i,
};

/** Is pressing this the thing that doubles this creature's jump for the turn? */
export function isJumpBoostActivity(item: any, activity: any): boolean {
  return isActionActivity(item, activity, STEP_OF_THE_WIND);
}
