// Why did that creature do that?
//
// Added after the first play test (2026-08-03), where every automated creature shouted for help and
// the cause — an unreadable item model returning zero attacks — was invisible from the outside. A
// planner that silently finds no options looks identical to a creature that has none, so the fastest
// possible answer to "what did it see?" is worth a console command.
//
// Call `game.modules.get("noodlr-hooks-55e").api.explainTurn()` with a token selected.

import { prewarmCastSpells, readActions } from "../actions";
import { planTurn } from "./planner";
import { chatterScore } from "../banter/profile";

export async function explainTurn(): Promise<void> {
  const selected: any = (canvas as any)?.tokens?.controlled?.[0];
  const combat = game.combat;
  if (!selected || !combat) {
    console.warn("Noodlr Hooks | select a token during combat first");
    return;
  }
  const tokenId = selected?.document?.id ?? selected?.id;
  const combatant: any = (combat.combatants as any)?.find?.(
    (c: any) => c.tokenId === tokenId || c.token?.id === tokenId,
  );
  if (!combatant) {
    console.warn("Noodlr Hooks | that token is not in the current combat");
    return;
  }

  // Same warm-up the real turn does, or the console would report fewer spells than the creature has.
  await prewarmCastSpells(combatant.actor);

  const actions = readActions(combatant.actor);
  console.group(`Noodlr Hooks | ${combatant.name}`);
  console.log(`chatter: ${chatterScore(combatant.actor)} of 10`);
  console.table(
    actions.map((a) => ({
      name: a.name,
      kind: a.kind,
      costs: a.economy,
      melee: a.melee,
      ranged: a.ranged,
      range: a.range,
      available: a.available,
    })),
  );
  if (actions.length === 0) {
    console.warn(
      "no readable actions — the creature will fall back to shouting for help. If it plainly " +
        "has attacks on its sheet, its item shape is not one combat/actions.ts understands.",
    );
  }

  const plan = planTurn(combatant);
  if (!plan) {
    console.warn("no plan: nothing it could do, or it is not placed on the scene");
  } else {
    console.log(
      `tier ${plan.profile.tier} (${plan.profile.descriptor}), noise ${plan.profile.noise}`,
    );
    console.table(
      plan.considered.map((o) => ({
        kind: o.kind,
        item: o.itemName ?? "",
        target: o.target?.name ?? "",
        score: Number(o.score.toFixed(2)),
        chosen: o === plan.chosen,
        why: o.reasons.join("; "),
      })),
    );
  }
  console.groupEnd();
}
