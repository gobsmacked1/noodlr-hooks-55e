// The Light property's extra attack, and what it costs. D&D 5e ONLY.
//
// SYSTEM-SPECIFIC BY NECESSITY, quarantined like the rider, declaration, Dash, jump and reaction tables.
// `rules/economy/` is allowed to know that an attack can be paid for out of a different slot; it is
// never allowed to know that the slot depends on a weapon property called Light.
//
// THE RULE (2024 PHB, "Light"). When you take the Attack action and attack with a Light weapon you are
// holding in one hand, you can make one extra attack as a BONUS ACTION later on the same turn with a
// different Light weapon in the other hand. Once per turn. The Two-Weapon Fighting style adds the
// ability modifier to that attack's damage and costs nothing at all — it is a passive damage change and
// has no place in an action ledger, which is why it appears nowhere below.
//
// THE NICK MASTERY changes the slot and nothing else: the extra attack becomes part of the Attack action
// instead of costing the bonus action. Still once per turn.
//
// WHY THE LEDGER NEEDED TELLING. dnd5e models none of this. There is no off-hand activity, no bonus-
// action variant of the weapon's attack, and nothing anywhere marks a swing as the second one — the
// player simply presses the same weapon twice. So both swings arrived as ordinary attacks claiming the
// Attack action, and a character without Extra Attack was refused their off-hand swing every single
// turn: the most routine thing a dual-wielding rogue or ranger does, broken by the layer meant to keep
// them honest.
//
// WHERE THIS IS CONSULTED, AND WHY IT MATTERS. Only at the point where the attack budget has already run
// out. That ordering is what makes the heuristic safe rather than clever: the FIRST Light swing of the
// turn is an ordinary Attack action attack and is charged as one, and nothing here ever runs for a
// character whose Extra Attack still has room in it. We are asked one question — "this creature is out
// of attacks and is swinging a Light weapon, is this the off-hand swing?" — and for a Light melee weapon
// the answer is yes far more often than not.
//
// THE ONE ACCEPTED IMPRECISION. The rules require the OTHER hand to hold a different Light weapon, and
// Foundry models no hands. A character with a single Light weapon and no second one therefore gets a
// swing the rules would not allow. That is the generous direction this layer takes everywhere: a
// wrongly-permitted attack is a bad turn the GM can call back, while a wrongly-refused one is a bug
// report about the module. The `light` counter in the ledger keeps it to one per turn either way.

import { isDnd5e } from "./dnd5e-rewards";

/** What the Light property's extra attack costs this creature. */
export type LightCost = "bonus" | "free";

/** dnd5e's key for the Light weapon property. Verified in `CONFIG.DND5E.itemProperties`. */
const LIGHT = "lgt";

function propertiesOf(item: any): Set<string> {
  const raw = item?.system?.properties;
  if (raw instanceof Set) return raw as Set<string>;
  if (Array.isArray(raw)) return new Set(raw.map(String));
  return new Set<string>();
}

/**
 * Does this creature actually have the weapon's mastery, or is the field just sitting there?
 *
 * `system.mastery` is a plain string on every weapon that has one, whether or not the wielder is
 * entitled to use it — dnd5e gates it on `traits.weaponProf.mastery.value` containing the base item,
 * which is the same test its own `masteryOptions` getter makes (`data/item/weapon.mjs:328`). Without
 * this check every dagger in the world would carry Nick and the bonus action would never be charged.
 */
function masteryInUse(actor: any, item: any): string {
  const mastery = String(item?.system?.mastery ?? "");
  if (!mastery) return "";
  const base = String(item?.system?.type?.baseItem ?? "");
  const entitled = actor?.system?.traits?.weaponProf?.mastery?.value;
  if (base && entitled?.has?.(base)) return mastery;
  // An extra mastery granted by a feature rather than by proficiency (Weapon Master's bonus list).
  const bonus = actor?.system?.traits?.weaponProf?.mastery?.bonus;
  if (Array.isArray(bonus) && bonus.includes(mastery)) return mastery;
  return "";
}

/**
 * Could this attack be the Light property's extra swing, and what would it cost?
 *
 * Null when the weapon cannot produce one at all, which is the common case and the only answer that
 * changes nothing. Melee only: the Light property exists on ranged weapons too (the hand crossbow), but
 * two-weapon fighting is written about melee weapons held in two hands, and the crossbow's own case is
 * governed by Loading and by the Crossbow Expert feat rather than by this rule.
 */
export function lightExtraAttackCost(actor: any, item: any, activity: any): LightCost | null {
  if (!isDnd5e()) return null;
  if (String(activity?.type ?? "") !== "attack") return null;
  if (String(item?.type ?? "") !== "weapon") return null;
  if (!propertiesOf(item).has(LIGHT)) return null;

  const attackType = String(activity?.attack?.type?.value ?? "");
  if (attackType === "ranged") return null;

  return masteryInUse(actor, item) === "nick" ? "free" : "bonus";
}
