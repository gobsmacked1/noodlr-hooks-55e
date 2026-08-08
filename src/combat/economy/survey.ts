// `game.modules.get("noodlr").api.surveyEconomy()` — what everyone in the fight has left, and why.
//
// Action economy failures are all of the same shape: something was allowed that should not have been, or
// refused when it should not have been, and the only way to tell which is to see the numbers the ledger
// was working from. Attacks-per-action is the field to look at first, because it is the one value here
// that is detected rather than counted, and a monster whose Multiattack did not parse is the most likely
// reason a legal swing was refused.

import { readFlag } from "../../util/flags";
import { getEconomyMode } from "../config";
import { notable, slotClaims } from "./claims";
import { budget, explainAttacksPerAction, stampFor } from "./ledger";

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
    const per = explainAttacksPerAction(actor);
    return {
      name: String(combatant?.name ?? "?"),
      isPlayer: Boolean(actor?.hasPlayerOwner),
      turn: stampFor(combat, combatant),
      actionsLeft: left.action,
      bonusLeft: left.bonus,
      reactionLeft: left.reaction,
      attacksLeft: left.attack,
      attacksPerAction: per.value,
      attacksPerActionFrom: per.source,
      // The raw flag, so a tally that disagrees with the derived numbers is visible rather than inferred.
      recorded: readFlag(actor, "spent") ?? null,
      claims: slotClaims(actor).filter(notable),
    };
  });

  return {
    mode,
    round: Number(combat.round ?? 0),
    turn: Number(combat.turn ?? 0),
    note:
      "Legendary, mythic and crew actions are dnd5e's own and are deliberately not counted here. " +
      "attacksPerAction is read from the extra-attack class features, or parsed from Multiattack prose " +
      "for monsters (attacksPerActionFrom says which); set flags.noodlr-hooks-55e.attacksPerAction on an " +
      "actor to override it (flags.noodlr.* is still read, for effects written before the split). " +
      "`claims` lists the features that would be charged a slot, plus anything already exempted as a " +
      "damage rider: an entry there with treatedAsRider null that is really extra damage on another " +
      "action wants flags.noodlr-hooks-55e.damageRider on its item, or a line in systems/dnd5e-riders.ts.",
    combatants: rows,
  };
}
