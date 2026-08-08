// Running a hostile creature's turn — locally, with no AI call.
//
// This replaces the streaming LLM turn loop that shipped in v0.4.21 (user's call, 2026-08-02: one
// model request per beat per creature made every encounter slow and expensive, and a horde fight
// unaffordable). Decisions now come from the deterministic planner in `auto/planner.ts`.
//
// Order of operations, and each part is deliberate:
//   1. plan   — the deterministic planner picks a verb, an implement and a target
//   2. offer  — the turn goes out on `noodlrHooks.turn` so a narrator can taunt, embellish or rewrite
//               the intent; it needs the plan first, because a taunt is aimed at whoever the creature
//               is about to deal with
//   3. announce — narration goes out BEFORE the dice, so the chat log reads as prose then resolution
//   4. perform — the token moves and the system's own item-use path rolls it, so Midi QoL and friends
//                resolve the mechanics exactly as if the GM had clicked the button
//   5. resolve — flee / surrender / mercy are recorded by the encounter layer
//
// A failure in step 4 is reported to the GM as a whisper and nothing else: the announcement stands, and
// a GM resolving one attack by hand has lost a click, whereas a thrown exception loses the turn.
//
// Step 2 is where the module split shows. Banter used to happen right here, reading the creature's
// sheet and then reaching for the AI module's text-to-speech. Now the sheet reading stays (it is
// system knowledge, which is this module's whole job) and travels out on the event as a profile, while
// the line library and the voice belong to whoever is listening. With nothing listening, monsters
// fight in silence, which is correct rather than broken.

import { log } from "../constants";
import { narrator, speakerFor } from "../util/speaker";
import { prewarmCastSpells } from "./actions";
import { planTurn, type PlanKind, type PlanOption, type TurnPlan } from "./auto/planner";
import { performPlan } from "./auto/execute";
import { resolveCombatant, type Outcome } from "./auto/encounter";
import { banterProfile } from "./banter/profile";
import { announceTurn } from "../integration/contract";
import { noteDossierEvent } from "./dossier";
import { TIER_CAVEAT } from "./auto/tiers";

/** The three ways a creature leaves a fight alive. */
const OUTCOMES: Partial<Record<PlanKind, Outcome>> = {
  flee: "fled",
  surrender: "surrendered",
  mercy: "mercy",
};

/** How this creature's movement reads in a sentence: it flies, it does not "close on foot". */
const TRAVEL: Record<string, { close: string; advance: string }> = {
  walk: { close: "closes", advance: "advances on" },
  fly: { close: "flies", advance: "wings toward" },
  swim: { close: "swims", advance: "swims toward" },
  burrow: { close: "tunnels", advance: "tunnels toward" },
  climb: { close: "climbs", advance: "climbs toward" },
};

/** One line the table reads: what the creature is doing, and to whom. */
function describeIntent(plan: TurnPlan): string {
  const me = plan.board.self.name;
  const o: PlanOption = plan.chosen;
  const target = o.target?.name ?? "";
  const units = plan.board.units;
  const travel = TRAVEL[plan.board.locomotion.primary] ?? TRAVEL.walk;

  switch (o.kind) {
    case "attack":
      return `${me} attacks ${target} with ${o.itemName}.`;
    case "close":
      return `${me} ${travel.close} ${Math.round(o.approach ?? 0)} ${units} on ${target} and attacks with ${o.itemName}.`;
    case "advance":
      return `${me} ${travel.advance} ${target}, still too far to strike.`;
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
    case "escape":
      return `${me} ${travel.close} ${o.spot?.travel ?? 0} ${units} ${o.spot?.bearing ?? "clear"} to get out of ${o.reasons[0]?.replace(/^standing in /, "") ?? "danger"}.`;
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
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.NoCombat"));
    return;
  }
  const combatant = combat.combatant;
  if (!combatant) {
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.NoCombatant"));
    return;
  }
  if (combatant.hasPlayerOwner ?? combatant.actor?.hasPlayerOwner) {
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.IsPC"));
    return;
  }

  await runTurnFor(combatant);
}

/** Plan and announce one specific combatant's turn. */
export async function runTurnFor(combatant: any): Promise<void> {
  try {
    // Planning is synchronous, but a monster's spells usually live behind a feat pointing into a
    // compendium pack, and resolving that pointer needs an await. Warm them first or the creature reads
    // as having no spells at all.
    await prewarmCastSpells(combatant?.actor);

    const plan = planTurn(combatant);
    if (!plan) {
      ui.notifications?.warn(
        game.i18n.format("NOODLRHOOKS.Combat.NoPlan", { name: combatant?.name ?? "?" }),
      );
      return;
    }

    const planned = plan.postscript
      ? `${describeIntent(plan)} …${plan.postscript}.`
      : describeIntent(plan);
    const reasoning = describeReasoning(plan);

    // Mouth first, then act. The heckled party member is resolved here rather than by the listener
    // because it comes out of the plan, and the banter profile is read here because reading a sheet
    // is this module's job. Everything past that — the line, the voice, the timing — is the
    // listener's, and `announceTurn` waits for it so a taunt cannot land after its own punchline.
    const heckled = plan.chosen.target?.isPC
      ? plan.chosen.target
      : plan.board.enemies.find((e) => e.isPC);
    const heckledActor = heckled ? { actor: heckled.actor, name: heckled.name } : null;

    const intent = await announceTurn({
      combatant,
      actor: combatant?.actor,
      token: combatant?.token,
      intent: planned,
      reasoning,
      target: plan.chosen.target ?? null,
      banter: heckledActor ? banterProfile(combatant?.actor, heckledActor) : null,
    });
    log(`${intent} [${reasoning}]`);

    // The intent is public — it is what the table watches happen. The reasoning stays in the console
    // and out of the chat log: players seeing "tier 3, looks like the easy one" would be told exactly
    // how the monster thinks, which is the GM's information, not theirs.
    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content: `<p>${foundry.utils.escapeHTML(intent)}</p>`,
      speaker: speakerFor(combatant?.token ?? combatant?.actor, plan.board.self.name),
    });

    // Now make it happen: move the token, nominate the target, and hand the roll to the system so the
    // table's automation resolves it. Announced first so the narration reads ahead of the dice cards.
    const performed = await performPlan(plan);
    if (performed.problem) {
      log(`execution problem for ${plan.board.self.name}: ${performed.problem}`);
      await ChatMessage.create({
        content: `<p><em>${foundry.utils.escapeHTML(plan.board.self.name)}: Noodlr could not carry that out (${foundry.utils.escapeHTML(performed.problem)}). Resolve it manually.</em></p>`,
        speaker: narrator(),
        whisper: ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
      });
    }

    noteDossierEvent(String(combatant.id ?? ""), `Round ${game.combat?.round ?? "?"}: ${intent}`);

    // Three of the outcomes take a creature out of the fight for good, on terms the addendum
    // spells out. Recording them is what lets an encounter end without a body count.
    const outcome = OUTCOMES[plan.chosen.kind];
    if (outcome) await resolveCombatant(combatant, outcome);
  } catch (err) {
    log("NPC turn planning failed:", err);
    ui.notifications?.error(game.i18n.format("NOODLRHOOKS.Combat.Failed", { error: String(err) }));
  }
}
