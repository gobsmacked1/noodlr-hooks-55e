// Taking the Disengage action, and remembering that you did.
//
// "Your movement doesn't provoke Opportunity Attacks for the rest of the turn." The opportunity-attack
// layer has always honoured that, and until now it could only find out by looking for an Active Effect
// whose NAME matched /disengag|withdraw/ — a convention some premade libraries follow and the system does
// not. dnd5e ships no `disengaged` status and no effect on its own Disengage item (verified 5.3.3:
// `CONFIG.DND5E` has no such condition, and the 2024 PHB item is a `utility` activity with `effects: []`).
// So on a stock world the button spent an Action and changed nothing that anything could read, and the
// creature was struck at anyway as it walked away.
//
// This is the same shape as the Hide bug and the Dash double-charge: two entrances to one action, and the
// one people actually press was the one nothing was watching.
//
// OBSERVED, NOT INTERCEPTED. The button is left alone to do exactly what it does — post its card, spend
// its Action through the ordinary ledger — and we only write down that it happened. There is nothing to
// adjudicate here (no roll, no prerequisite, no target), so cancelling the activity would replace a
// working button with a reimplementation of it for no gain. Compare Hide, where the whole rule lives on
// our side and letting the sheet also run would say a second, quieter thing about the same action.
//
// THE MARK IS TURN-STAMPED AND NEVER CLEARED, which is the same trick the action ledger uses: a flag
// carrying the turn it belongs to reads as absent on any other turn, so nothing has to remember to reset
// it, every client computes the same answer, and a fight that ends mid-turn leaves nothing stale behind.
// "For the rest of the turn" is then literally what is stored rather than something a hook has to enforce.

import { MODULE_ID, log } from "../constants";
import { readFlag } from "../util/flags";
import { isDisengageActivity } from "../system/dnd5e-actions";
import { stampFor } from "./economy/ledger";

const FLAG = "disengaged";

/** Words a system or module might use for "I chose not to provoke this". Matched loosely on purpose. */
const DISENGAGED = /disengag|withdraw/i;

/** The combatant this actor is fighting as, if it is in the fight at all. */
function combatantFor(combat: any, actor: any): any {
  const uuid = String(actor?.uuid ?? "");
  const id = String(actor?.id ?? "");
  return (combat?.combatants ?? []).find?.(
    (c: any) => String(c?.actor?.uuid ?? "") === uuid || String(c?.actor?.id ?? "") === id,
  );
}

/**
 * Write down that this creature disengaged on the turn it is currently taking.
 *
 * Outside a fight there is no turn to be "the rest of" and nothing provokes anyway, so nothing is
 * recorded — pressing the button out of combat is a player telling the table what they are doing, which
 * is what the chat card is for.
 */
export async function noteDisengage(actor: any): Promise<boolean> {
  const combat: any = game.combat;
  if (!combat?.started || !actor) return false;
  const combatant = combatantFor(combat, actor);
  if (!combatant) return false;

  try {
    await actor.setFlag?.(MODULE_ID, FLAG, stampFor(combat, combatant));
    log(`reaction: ${String(actor.name)} disengaged; its movement provokes nothing this turn`);
    return true;
  } catch (err) {
    // A player pressing Disengage on their own character always may; anything else is a sheet they do
    // not own, and losing the mark is better than a permission error in front of the table.
    log(`reaction: could not record ${String(actor?.name)}'s Disengage:`, err);
    return false;
  }
}

/**
 * Has this creature disengaged this turn?
 *
 * Our own mark first, then the name convention, because the convention is what other modules write and a
 * world running one of them should keep working exactly as it did before this file existed.
 */
export function hasDisengaged(actor: any): boolean {
  const combat: any = game.combat;
  if (combat?.started) {
    const combatant = combatantFor(combat, actor);
    if (combatant && String(readFlag(actor, FLAG) ?? "") === stampFor(combat, combatant))
      return true;
  }

  try {
    for (const status of (actor?.statuses ?? []) as Set<string>) {
      if (DISENGAGED.test(String(status))) return true;
    }
    for (const effect of actor?.appliedEffects ?? actor?.effects ?? []) {
      if (DISENGAGED.test(String(effect?.name ?? effect?.label ?? ""))) return true;
    }
  } catch {
    /* an unreadable effect list is not evidence of a disengage */
  }
  return false;
}

/**
 * Watch for the button being pressed, wherever it was pressed.
 *
 * `dnd5e.postUseActivity` rather than `preUseActivity`: the mark should record an action that actually
 * happened, and a use can still be refused between the two — by our own economy layer, among others.
 * Registered on every client, because the client that presses is the one that owns the sheet and so the
 * only one allowed to write the flag.
 */
export function registerDisengageWatch(): void {
  Hooks.on("dnd5e.postUseActivity", (activity: any) => {
    try {
      if (!isDisengageActivity(activity?.item, activity)) return;
      void noteDisengage(activity?.actor);
    } catch (err) {
      log("reaction: the Disengage watch failed:", err);
    }
  });
}
