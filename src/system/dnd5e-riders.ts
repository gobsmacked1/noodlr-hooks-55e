// Features that add damage to something else and cost nothing of their own. D&D 5e ONLY.
//
// Sneak Attack is the specimen and the reason this file exists (user's report, 2026-08-07): a rogue who
// hit, was offered Sneak Attack, and was then told they had already used their action for the turn. The
// rule is not ambiguous — "once per turn, you can deal an extra 1d6 damage to one creature you hit with
// an attack roll" (PHB 2024, Rogue 1). It is extra damage on a hit that has already happened. There is no
// second action, and the offhand swing a rogue often adds it to is a bonus action that was already paid
// for by Two-Weapon Fighting.
//
// WHY A TABLE RATHER THAN A STRUCTURAL TEST. The obvious rule — "an activity of type `damage` never costs
// a slot" — is wrong, and measurably so. A census of dnd5e 5.3.3's own authored content (3,246 activities
// across 3,199 items; `scripts/census-damage-activities.mjs`) finds 62 damage activities that legitimately
// claim a real slot: 57 actions, 4 bonus actions and one reaction, among them Holy Nimbus, every flask of
// oil in the game, Divine Eminence and Heat Metal. Exempting damage activities wholesale would make all of
// those free.
//
// The same census shows dnd5e models riders correctly on its own: of its damage activities, 92 carry an
// empty activation and 13 carry `special`, and `slotFor` already declines to police either. So a stock
// world never needed this file. What needs it is everything downstream of stock — ddb-importer, premade
// libraries, and hand-edited sheets, one of which had given Sneak Attack a real activation. This table is
// how a rider stays a rider whatever its activation says.
//
// HOW EACH IS RECOGNISED, in the order tried:
//   * `flags.noodlr.damageRider` on the item, for anything this list has never heard of. An ordinary
//     Active Effect or a one-line flag edit is enough, and no code here changes.
//   * `system.identifier`, which is stable across dnd5e versions and localisations where names are not.
//     Same mechanism as Extra Attack and the bonus-action Dash sources.
//   * the item's name, for homebrew and imports that carry no identifier — which is exactly the
//     population that gets the activation wrong in the first place.

import { isDnd5e } from "./dnd5e-rewards";
import { hasFlag } from "../util/flags";

/**
 * Set this on an item (or via an Active Effect) to declare it a damage rider.
 *
 * Read under this module's namespace and under `noodlr`, which is where it was documented before the
 * split — see util/flags.ts.
 */
const FLAG_KEY = "damageRider";

interface Rider {
  label: string;
  /** `system.identifier` values, as dnd5e authors them. */
  identifiers: string[];
  /** Matched against the item's name when no identifier is present. */
  pattern: RegExp;
}

/**
 * Extra damage folded into an attack or a spell you have already paid for.
 *
 * Every entry was read out of dnd5e's own content rather than recalled, so the identifiers are the real
 * ones. Deliberately absent:
 *
 *   Divine Smite. Free in 2014 and a bonus-action SPELL in 2024, and the two share the identifier
 *   `divine-smite`. Listing it would hand 2024 paladins a free bonus action, and listing it buys nothing
 *   in 2014 because the legacy feature already carries `special`.
 *
 *   Holy Nimbus, Divine Eminence, Heat Metal, thrown oil. Damage activities that really do cost a slot;
 *   they are the reason this is a list and not a rule.
 *
 *   Great Weapon Master's and Polearm Master's extra swings, which are genuine bonus-action attacks.
 */
const RIDERS: Rider[] = [
  { label: "Sneak Attack", identifiers: ["sneak-attack"], pattern: /sneak\s*attack/i },
  {
    // 2024 spends Sneak Attack dice on an effect rather than an action.
    label: "Cunning Strike",
    identifiers: ["cunning-strike", "devious-strikes"],
    pattern: /cunning\s*strike|devious\s*strikes/i,
  },
  {
    label: "Hunter's Prey",
    identifiers: ["hunters-prey", "superior-hunters-prey", "colossus-slayer"],
    pattern: /hunter'?s\s*prey|colossus\s*slayer/i,
  },
  { label: "Foe Slayer", identifiers: ["foe-slayer"], pattern: /foe\s*slayer/i },
  {
    label: "Divine Strike",
    identifiers: ["divine-strike", "blessed-strikes-divine-strike", "radiant-strikes"],
    pattern: /divine\s*strike|radiant\s*strikes/i,
  },
  {
    label: "Potent Spellcasting",
    identifiers: ["potent-spellcasting", "blessed-strikes-potent-spellcasting"],
    pattern: /potent\s*spellcasting/i,
  },
  {
    label: "Primal Strike",
    identifiers: ["primal-strike", "elemental-fury-primal-strike"],
    pattern: /primal\s*strike/i,
  },
  { label: "Brutal Strike", identifiers: ["brutal-strike"], pattern: /brutal\s*strike/i },
  { label: "Frenzy", identifiers: ["frenzy"], pattern: /^frenzy$/i },
  { label: "Lifedrinker", identifiers: ["lifedrinker"], pattern: /lifedrinker/i },
  { label: "Eldritch Smite", identifiers: ["eldritch-smite"], pattern: /eldritch\s*smite/i },
  {
    label: "Empowered Evocation",
    identifiers: ["empowered-evocation"],
    pattern: /empowered\s*evocation/i,
  },
  { label: "Overchannel", identifiers: ["overchannel"], pattern: /overchannel/i },
  {
    label: "Elemental Affinity",
    identifiers: ["elemental-affinity"],
    pattern: /elemental\s*affinity/i,
  },
  {
    label: "Hurl Through Hell",
    identifiers: ["hurl-through-hell"],
    pattern: /hurl\s*through\s*hell/i,
  },
];

function flagged(item: any): boolean {
  return hasFlag(item, FLAG_KEY);
}

/**
 * Is this a rider — extra damage on an action already spent — rather than an action of its own?
 *
 * Returns the feature's label so callers can say which rule they applied, or null. Takes the item rather
 * than the activity because that is where the identifier and the flag live; the activity is accepted so a
 * caller that only has one can reach the item through it.
 */
export function damageRiderOf(item: any, activity?: any): string | null {
  // Gated here rather than at every call site so that `actions.ts`, which is deliberately
  // system-agnostic, can ask the question without knowing whose rules the answer comes from. On another
  // system this returns null for everything and the planner behaves exactly as it did before.
  if (!isDnd5e()) return null;
  const owner = item ?? activity?.item ?? null;
  if (!owner) return null;
  if (flagged(owner)) return String(owner?.name ?? "a damage rider");

  const identifier = String(owner?.system?.identifier ?? "")
    .trim()
    .toLowerCase();
  const name = String(owner?.name ?? "").trim();

  for (const rider of RIDERS) {
    if (identifier && rider.identifiers.includes(identifier)) return rider.label;
    // Only fall back to the name when the sheet states no identifier. A world that has deliberately
    // re-identified a feature should not have that overruled by what it happens to be called.
    if (!identifier && name && rider.pattern.test(name)) return rider.label;
  }
  return null;
}

export function isDamageRider(item: any, activity?: any): boolean {
  return damageRiderOf(item, activity) !== null;
}
