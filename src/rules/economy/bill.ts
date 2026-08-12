// Charging a slot for an action taken outside the activity pipeline.
//
// `economy/enforce.ts` bills whatever goes through `dnd5e.preUseActivity`. Several of our own rules do
// not: the Hide button, Administer First Aid and the Influence action all cancel the sheet's activity and
// resolve the action themselves, so each has to take the slot by hand. Doing that in three places is how
// three answers to "is it this creature's turn" eventually diverge, which is the same reasoning that put
// the button recognisers in one file.
//
// WHAT IS DELIBERATELY NOT HERE. The over-budget dialog. `enforce.ts` asks rather than refuses because the
// rules are full of features that legitimately break the general rule, and every one of those already
// works by raising the allowance through `flags.noodlr.extraAction`. A rule that resolves itself has no
// such exception to accommodate, so it refuses and says why — and the way past a refusal is `force`.

import { getEconomyMode } from "../../settings";
import { check, spend, type Slot } from "./ledger";

export interface TurnBill {
  slot: Slot;
  combat: any;
  combatant: any;
  actor: any;
}

/** The combatant this actor is fighting as, if it is in the fight at all. */
function combatantFor(combat: any, actor: any): any {
  const uuid = String(actor?.uuid ?? "");
  const id = String(actor?.id ?? "");
  return (combat?.combatants ?? []).find?.(
    (c: any) => String(c?.actor?.uuid ?? "") === uuid || String(c?.actor?.id ?? "") === id,
  );
}

/**
 * What this action costs the creature right now, or null when nothing should be charged.
 *
 * Null outside a started fight and outside the creature's own turn, matching the movement cap and the
 * activity veto: there is no turn to be over budget in during downtime, and a GM staging a scene is not
 * spending anything.
 */
export function turnBill(actor: any, slot: Slot): TurnBill | null {
  if (!actor) return null;
  const combat: any = game.combat;
  if (!combat?.started) return null;

  const combatant = combatantFor(combat, actor);
  if (!combatant || String(combatant.id) !== String(combat.combatant?.id ?? "")) return null;

  return { slot, combat, combatant, actor };
}

/** Can this be paid for? True when there is nothing to pay, which is not the same as free. */
export function affordable(bill: TurnBill | null): boolean {
  if (!bill || getEconomyMode() === "off") return true;
  return check(bill.actor, bill.combat, bill.combatant, bill.slot, false).allowed;
}

/** Take the slot. Silently does nothing when there was nothing to bill. */
export function payBill(bill: TurnBill | null): void {
  if (!bill) return;
  spend(bill.actor, bill.combat, bill.combatant, bill.slot, false);
}

/** "action" / "bonus action" / "reaction", for the sentence explaining a refusal. */
export function slotLabel(slot: Slot): string {
  return slot === "bonus" ? "bonus action" : slot;
}
