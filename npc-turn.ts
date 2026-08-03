// Running a hostile creature's turn — locally, with no AI call.
//
// This replaces the streaming LLM turn loop that shipped in v0.4.21 (user's call, 2026-08-02: one
// model request per beat per creature made every encounter slow and expensive, and a horde fight
// unaffordable). Decisions now come from the deterministic planner in `auto/planner.ts`.
//
// This pass DECIDES AND ANNOUNCES ONLY. Nothing is moved, spent, or applied: the plan is posted to
// chat so the GM can see what the creature intends and resolve it themselves. Execution through the
// system's own item-use path — where a bug can actually damage a world — is the next layer, and it
// arrives with GM approval on by default.

import { log } from "../constants";
import { planTurn, type PlanKind, type PlanOption, type TurnPlan } from "./auto/planner";
import { resolveCombatant, type Outcome } from "./auto/encounter";
import { noteDossierEvent } from "./dossier";
import { TIER_CAVEAT } from "./auto/tiers";

/** The three ways a creature leaves a fight alive. */
const OUTCOMES: Partial<Record<PlanKind, Outcome>> = {
  flee: "fled",
  surrender: "surrendered",
  mercy: "mercy",
};

/** One line the table reads: what the creature is doing, and to whom. */
function describeIntent(plan: TurnPlan): string {
  const me = plan.board.self.name;
  const o: PlanOption = plan.chosen;
  const target = o.target?.name ?? "";
  const units = plan.board.units;

  switch (o.kind) {
    case "attack":
      return `${me} attacks ${target} with ${o.itemName}.`;
    case "close":
      return `${me} closes ${Math.round(o.approach ?? 0)} ${units} on ${target} and attacks with ${o.itemName}.`;
    case "heal-self":
      return `${me} uses ${o.itemName} on itself.`;
    case "heal-ally":
      return `${me} uses ${o.itemName} on ${target}.`;
    case "control":
      return `${me} uses ${o.itemName} against ${target}.`;
    case "kite":
      return `${me} backs out of melee and shoots ${target} with ${o.itemName}.`;
    case "hide":
      return `${me} slips ${o.spot?.travel ?? 0} ${units} ${o.spot?.bearing ?? "away"} and hides, out of ${o.observer ?? target}'s sight.`;
    case "help":
      return `${me} moves to help ${target}.`;
    case "surrender":
      return `${me} throws down its weapon and surrenders.`;
    case "mercy":
      return `${me} lowers its weapon and spares the party.`;
    case "flee":
      return `${me} breaks off and tries to escape.`;
    case "call":
      return `${me} calls out for help.`;
    default:
      return `${me} hesitates.`;
  }
}

/** GM-only footnote: the tier that produced this and why the option scored well. */
function describeReasoning(plan: TurnPlan): string {
  const mental = plan.mental === null ? "unknown" : plan.mental.toFixed(1);
  const why =
    plan.chosen.reasons.length > 0 ? plan.chosen.reasons.join("; ") : "nothing else to do";
  const caveat =
    plan.profile.tier > TIER_CAVEAT
      ? " (tiers above genius have no mechanical behaviors yet — see AGENTS.md)"
      : "";
  return `Tier ${plan.profile.tier}, ${plan.profile.descriptor} — (INT+WIS)/2 = ${mental}. Chose: ${why}.${caveat}`;
}

/**
 * Decide and announce the current combatant's turn. Safe to call repeatedly: the choice is seeded
 * from fight/round/creature, so the same turn always produces the same decision.
 */
export async function runCurrentNpcTurn(): Promise<void> {
  const combat = game.combat;
  if (!combat?.started) {
    ui.notifications?.warn(game.i18n.localize("NOODLR.Combat.NoCombat"));
    return;
  }
  const combatant = combat.combatant;
  if (!combatant) {
    ui.notifications?.warn(game.i18n.localize("NOODLR.Combat.NoCombatant"));
    return;
  }
  if (combatant.hasPlayerOwner ?? combatant.actor?.hasPlayerOwner) {
    ui.notifications?.warn(game.i18n.localize("NOODLR.Combat.IsPC"));
    return;
  }

  await runTurnFor(combatant);
}

/** Plan and announce one specific combatant's turn. */
export async function runTurnFor(combatant: any): Promise<void> {
  try {
    const plan = planTurn(combatant);
    if (!plan) {
      ui.notifications?.warn(
        game.i18n.format("NOODLR.Combat.NoPlan", { name: combatant?.name ?? "?" }),
      );
      return;
    }

    const intent = plan.postscript
      ? `${describeIntent(plan)} …${plan.postscript}.`
      : describeIntent(plan);
    const reasoning = describeReasoning(plan);
    log(`${intent} [${reasoning}]`);

    // The intent is public — it is what the table watches happen. The reasoning stays in the console
    // and out of the chat log: players seeing "tier 3, looks like the easy one" would be told exactly
    // how the monster thinks, which is the GM's information, not theirs.
    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content: `<p>${foundry.utils.escapeHTML(intent)}</p>`,
      speaker: { alias: plan.board.self.name },
    });

    noteDossierEvent(String(combatant.id ?? ""), `Round ${game.combat?.round ?? "?"}: ${intent}`);

    // Three of the outcomes take a creature out of the fight for good, on terms the addendum
    // spells out. Recording them is what lets an encounter end without a body count.
    const outcome = OUTCOMES[plan.chosen.kind];
    if (outcome) await resolveCombatant(combatant, outcome);
  } catch (err) {
    log("NPC turn planning failed:", err);
    ui.notifications?.error(game.i18n.format("NOODLR.Combat.Failed", { error: String(err) }));
  }
}
