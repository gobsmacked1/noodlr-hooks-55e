// `game.modules.get("noodlr").api.surveyEconomy()` — what everyone in the fight has left, and why.
//
// Action economy failures are all of the same shape: something was allowed that should not have been, or
// refused when it should not have been, and the only way to tell which is to see the numbers the ledger
// was working from. Attacks-per-action is the field to look at first, because it is the one value here
// that is detected rather than counted, and a monster whose Multiattack did not parse is the most likely
// reason a legal swing was refused.

import { getEconomyMode } from "../config";
import { damageRiderOf } from "../systems/dnd5e-riders";
import { attacksPerAction, budget, slotFor, stampFor } from "./ledger";

/**
 * Everything on this sheet that claims a real slot, and whether we treat it as a damage rider.
 *
 * The Sneak Attack report (2026-08-07) could not be diagnosed from the numbers alone, because the tally was
 * correct — it was the thing being counted that should not have been. This lists what would be charged, so
 * a feature carrying an activation stock dnd5e never gave it is visible at a glance.
 */
function slotClaims(actor: any): unknown[] {
  const out: unknown[] = [];
  for (const item of actor?.items ?? []) {
    const activities: any[] = item?.system?.activities?.contents ?? [];
    for (const activity of activities) {
      const slot = slotFor(activity?.activation?.type);
      if (!slot) continue;
      const rider = damageRiderOf(item, activity);
      out.push({
        item: String(item?.name ?? "?"),
        identifier: String(item?.system?.identifier ?? "") || null,
        activity: String(activity?.name ?? "") || String(activity?.type ?? ""),
        claims: slot,
        treatedAsRider: rider,
      });
    }
  }
  return out;
}

export function surveyEconomy(): Record<string, unknown> {
  const combat: any = game.combat;
  const mode = getEconomyMode();

  if (!combat?.started) {
    return {
      mode,
      note: "No fight in progress. Nothing is counted outside combat, by design.",
      combatants: [],
    };
  }

  const rows = (combat.combatants ?? []).map((combatant: any) => {
    const actor = combatant?.actor;
    const left = actor ? budget(actor, combat, combatant) : {};
    return {
      name: String(combatant?.name ?? "?"),
      isPlayer: Boolean(actor?.hasPlayerOwner),
      turn: stampFor(combat, combatant),
      actionsLeft: left.action,
      bonusLeft: left.bonus,
      reactionLeft: left.reaction,
      attacksLeft: left.attack,
      attacksPerAction: actor ? attacksPerAction(actor) : 1,
      // The raw flag, so a tally that disagrees with the derived numbers is visible rather than inferred.
      recorded: actor?.getFlag?.("noodlr", "spent") ?? null,
      claims: slotClaims(actor),
    };
  });

  return {
    mode,
    round: Number(combat.round ?? 0),
    turn: Number(combat.turn ?? 0),
    note:
      "Legendary, mythic and crew actions are dnd5e's own and are deliberately not counted here. " +
      "attacksPerAction is read from the extra-attack class features, or parsed from Multiattack prose " +
      "for monsters; set flags.noodlr.attacksPerAction on an actor to override it. `claims` lists every " +
      "activity that would be charged a slot: anything there that is really extra damage on another " +
      "action wants flags.noodlr.damageRider set on its item, or an entry in systems/dnd5e-riders.ts.",
    combatants: rows,
  };
}
