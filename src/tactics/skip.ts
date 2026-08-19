// Whether an automated creature's turn should be played, or skipped past.
//
// Split out of `hooks.ts` so a test can pin the predicate without loading the turn loop. `takeTurn`
// and `runTurnFor` both ask this; two implementations of "can this creature act" is how a paralyzed
// Assassin walks while the activity veto correctly refuses its swing.

import { readHp } from "../core/tracker";
import { isIncapacitated } from "../system/dnd5e-conditions";

/**
 * Is this creature out of the fight?
 *
 * Read from the tracker's own defeated mark AND from hit points, because the two disagree often enough
 * to matter: a creature killed by a module that never set the status is still a corpse, and a GM who
 * ticked the skull on something at full health has still said it is out.
 */
export function isDown(combatant: any): boolean {
  if (combatant?.isDefeated) return true;
  const hp = readHp(combatant?.actor);
  return Boolean(hp && hp.value !== null && hp.value <= 0);
}

/**
 * Must this combatant's automated turn be skipped?
 *
 * Dead, or Incapacitated (including Paralyzed / Stunned / Unconscious / Petrified). Not Grappled or
 * Restrained — those still get a turn. Not gated on the condition-automation switch: that switch is
 * attack-math, and a planner that walks a Hold Person target is a lie regardless of who owns Advantage.
 */
export function isUnableToAct(combatant: any): boolean {
  if (isDown(combatant)) return true;
  return isIncapacitated(combatant?.actor);
}

/** Short reason for the skip log. Dead wins over incapacitated when both are true. */
export function skipReason(combatant: any): "out of the fight" | "incapacitated" | null {
  if (isDown(combatant)) return "out of the fight";
  if (isIncapacitated(combatant?.actor)) return "incapacitated";
  return null;
}
