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
// instead of costing the bonus action. Still once per turn. Entitlement is `usableMastery` — the tag
// on every dagger is not the feature.
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
// ENTITLEMENT, NOT "HOLDING TWO LIGHT WEAPONS". The printed 2024 Light extra is available to
// anyone holding two Light melee weapons. At the table that handed every dual-dagger Sorcerer
// a bonus-action second swing they had never been taught. Nick (the mastery list) still makes
// it free; Two-Weapon Fighting or Dual Wielder still makes it a bonus action. Holding two
// daggers is not enough. The `light` counter in the ledger keeps it to one per turn either way.

import { isDnd5e } from "./dnd5e-rewards";
import { usableMastery } from "./dnd5e-masteries";

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

  if (usableMastery(actor, item) === "nick") return "free";
  if (hasTwoWeaponFighting(actor)) return "bonus";
  return null;
}

const TWF_IDS = new Set(["two-weapon-fighting", "dual-wielder"]);
const TWF_NAMES = [/^\s*two-weapon fighting\s*$/i, /^\s*dual wielder\s*$/i];

/** Fighting style or Dual Wielder — the bonus-action extra, not Nick. */
export function hasTwoWeaponFighting(actor: any): boolean {
  for (const it of actor?.items ?? []) {
    const id = String(it?.system?.identifier ?? "").toLowerCase();
    if (id && TWF_IDS.has(id)) return true;
    if (!id && TWF_NAMES.some((p) => p.test(String(it?.name ?? "")))) return true;
  }
  return false;
}
