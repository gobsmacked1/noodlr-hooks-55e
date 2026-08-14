// Legendary resistances, as dnd5e stores and spends them.
//
// Quarantined here for the usual reason: `rules/legendary.ts` decides WHEN a resistance is worth offering,
// which is a judgement about a fight, and this file knows WHERE the counter lives, which is a fact about
// D&D 5e. A second game system replaces this file and nothing else.
//
// WHAT THE SYSTEM ALREADY DOES, verified in 5.3.3 rather than assumed, because it is more than the rest of
// this module's findings would lead you to expect. `resources.legres` is a real schema field on the NPC
// data model with `max` and `spent` (`data/actor/npc.mjs:113`), `value` is derived from the pair
// (`:446`), both are refilled on a long rest (`:477`), and `NPCData#resistSave` (`:557-563`) spends one and
// stamps `flags.dnd5e.roll.forceSuccess` on the failed save. The chat card even draws the button:
// `_enrichSaveTooltip` (`documents/chat-message.mjs:637-670`) renders "Resist" on any failed NPC save where
// a resistance remains and the reader owns the creature.
//
// SO THE GAP IS NOT THE MECHANIC, IT IS THE MOMENT — and it is a gap this module made worse. dnd5e's button
// waits for a human to notice it, which was harmless while a human was also applying the damage by hand.
// Now that `rules/saves.ts` rolls the save and settles the damage in one breath, the button appears on a
// card whose consequences have already landed. Automation that closes a window the system left open is a
// regression even though every individual piece of it is correct.
//
// ONE THING TO KNOW ABOUT `forceSuccess`: it is read by the RENDERER and by nothing else. `BasicRoll#isSuccess`
// is computed from the total against the DC and knows nothing about it, so a GM who presses dnd5e's own
// button is invisible to any layer that asks the roll whether it succeeded. `cards.ts` reads the flag for
// exactly this reason.

import { log } from "../constants";
import { isDnd5e } from "./dnd5e-rewards";

/** What a creature has left, when it is the kind of creature that has any. */
export interface Resistances {
  value: number;
  max: number;
}

/**
 * A creature's remaining legendary resistances, or null when the concept does not apply to it.
 *
 * Null for a player character by construction: `resources.legres` lives on the NPC data model, so a
 * character simply has no such field. That is the honest test rather than a check on the sheet type.
 */
export function legendaryResistances(actor: any): Resistances | null {
  if (!isDnd5e()) return null;
  const res = actor?.system?.resources?.legres;
  if (!res) return null;
  const max = Number(res.max);
  if (!Number.isFinite(max) || max <= 0) return null;
  const value = Number(res.value);
  return { value: Number.isFinite(value) ? value : 0, max };
}

/** Has this creature got one to spend right now? */
export function canResist(actor: any): boolean {
  return (legendaryResistances(actor)?.value ?? 0) > 0;
}

/** Has this save already been resisted, by us or by a human pressing dnd5e's own button? */
export function alreadyResisted(message: any): boolean {
  return message?.flags?.dnd5e?.roll?.forceSuccess === true;
}

/**
 * Spend one and turn the save into a success.
 *
 * Routed through the system's own `resistSave` so the two writes stay its business: it validates that the
 * message really is a save, refuses when none remain or when it has already been resisted, and — the part
 * worth not reimplementing — writes `spent` rather than `value`, which is the derived half of the pair.
 * Writing `value` would be overwritten on the next data preparation.
 *
 * The fallback exists because `resistSave` is a recent addition and a table can be a version behind, not
 * because we would rather do it ourselves; it performs the same two writes in the same order.
 */
export async function spendResistance(actor: any, message: any): Promise<boolean> {
  try {
    if (typeof actor?.system?.resistSave === "function") {
      await actor.system.resistSave(message);
      return true;
    }
    const spent = Number(actor?.system?.resources?.legres?.spent ?? 0);
    await actor.update({ "system.resources.legres.spent": spent + 1 });
    await message.setFlag("dnd5e", "roll.forceSuccess", true);
    return true;
  } catch (err) {
    log("legendary resistance: could not spend one:", err);
    return false;
  }
}

/** Current hit points, for judging whether a failed save is worth a resistance. */
export function currentHp(actor: any): number | null {
  const value = Number(actor?.system?.attributes?.hp?.value);
  return Number.isFinite(value) ? value : null;
}
