// The Graze weapon mastery: damage on a miss. D&D 5e ONLY.
//
// "If your attack roll with this weapon misses a creature, you can deal damage to that creature equal to
// the ability modifier you used to make the attack roll. This damage is the same type dealt by the weapon,
// and the damage can be increased only by increasing the ability modifier." (PHB 2024, Appendix D.)
//
// NOTHING ENFORCES IT, and the tell is the one `documentation-signals.md` describes: `DND5E.weaponMasteries`
// gives every mastery exactly `{label, reference}` and nothing else, so the whole table exists to be linked
// to from a tooltip. `graze` as a whole word appears nowhere in `module/**.mjs` outside those config lines.
// The mastery is chosen on the attack dialog, recorded on the attack message, and then read by nobody.
//
// WHY IT IS THE DAMAGE GATE'S PROBLEM. Locking the Damage button on a miss is right for every weapon except
// these, and a Greatsword is not a rare weapon. The wrong fix is to unlock the button: pressing it rolls
// 2d6 plus the modifier, which is not what Graze deals — Graze is the modifier ALONE, no dice, and the rule
// says so twice (once in the sentence and once in the clause about how it can be increased). So the button
// stays locked and this supplies the flat amount, which `rules/damage.ts` applies directly.
//
// This is also the only honest reading available: there is no "graze damage" field anywhere to roll.

import { masteryOf } from "../rules/cards";
import { weaponDamageType } from "./dnd5e-damage";

/** What Graze deals on one miss. */
export interface Graze {
  amount: number;
  type: string;
}

/**
 * The Graze damage an attack roll deals to each creature it missed, or null when it deals none.
 *
 * Takes the ATTACK ROLL message, because `flags.dnd5e.roll.mastery` is the authoritative record of which
 * mastery was actually chosen for this swing — a weapon can be mastered and the mastery declined.
 *
 * A modifier of zero or less deals nothing and returns null rather than a zero-damage entry. That is a real
 * case (a Strength 10 fighter with a Greatsword) and the rule has nothing to say about it; posting "takes 0
 * bludgeoning" would be noise on every miss.
 */
export function grazeDamage(attack: any, item: any, activity: any): Graze | null {
  if (masteryOf(attack, item) !== "graze") return null;

  const ability = String(activity?.ability ?? "");
  if (!ability) return null;
  const mod = Number(activity?.actor?.system?.abilities?.[ability]?.mod);
  if (!Number.isFinite(mod) || mod <= 0) return null;

  return { amount: Math.floor(mod), type: weaponDamageType(activity, item) };
}
