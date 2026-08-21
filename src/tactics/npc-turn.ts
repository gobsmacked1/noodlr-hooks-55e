// Running a hostile creature's turn — locally, with no AI call.
//
// This replaces the streaming LLM turn loop that shipped in v0.4.21 (user's call, 2026-08-02: one
// model request per beat per creature made every encounter slow and expensive, and a horde fight
// unaffordable). Decisions now come from the deterministic planner in `tactics/planner.ts`.
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
import { planTurn, type PlanKind, type PlanOption, type TurnPlan } from "./planner";
import { performPlan, type Performed } from "./execute";
import { resolveCombatant, type Outcome } from "./encounter";
import { beginFlee, isFleeingCombatant, continueFlee } from "./flee";
import { banterProfile } from "./banter";
import { announceTurn } from "../integration/contract";
import { noteDossierEvent } from "./dossier";
import { TIER_CAVEAT } from "./tiers";
import { isUnableToAct, skipReason } from "./skip";

/** The three ways a creature leaves a fight alive. */
const OUTCOMES: Partial<Record<PlanKind, Outcome>> = {
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
  const line = describeIntentBody(plan);
  if (!plan.stand) return line;
  const me = plan.board.self.name;
  if (!line.startsWith(me)) return `${me} stands, then ${line}`;
  const rest = line.slice(me.length).trimStart();
  if (!rest) return `${me} stands.`;
  return `${me} stands, then ${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
}

function describeIntentBody(plan: TurnPlan): string {
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
    // The distance is filled in afterwards by `amend`, because an advance IS its movement and a
    // sentence that omits the number reads the same whether the creature crossed forty feet or stood
    // still. Reported as "no ground" rather than omitted when it moved nothing: that is the case the
    // GM most needs to see, and it was invisible.
    case "advance":
      return `${me} ${travel.advance} ${target}, still too far to strike.`;
    // Deliberately names nobody, the same rule the readied action follows. Who a monster has lost is
    // the hider's information: a card reading "searches for Rogwiz" tells the whole table that the
    // rogue is the one it cannot find, which is most of what the hide was bought for. The GM gets the
    // name in the reasoning footnote.
    case "search":
      return `${me} ${travel.advance} the spot where it last saw its quarry, searching.`;
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
    // Deliberately does not name the trigger. What a creature is waiting for is exactly what the party is
    // meant to discover by walking into it, so the public line says only that it is waiting and the
    // declaration itself is whispered to GMs.
    case "ready":
      return `${me} holds ${o.itemName ?? "its ground"} and waits.`;
    default:
      return `${me} hesitates.`;
  }
}

/**
 * Plans whose entire content is the movement, so the distance covered is the whole report.
 *
 * `close` and `kite` are deliberately absent: they end in a real item use, so the swing is the news and
 * the distance already rides in the sentence from `option.approach`.
 */
const TRAVEL_ONLY = new Set<PlanKind>(["advance", "search", "help"]);

/**
 * The intent again, now that it is known how far the creature actually got.
 *
 * Same lesson as the heal that announced fifteen hit points at full health: **a layer that reports what
 * it INTENDED rather than what it DID is indistinguishable from a broken layer.** "Troll Limb advances
 * on Rogwiz Ardue, still too far to strike" was reported three times in one fight and read as a
 * creature sitting in place — it had in fact walked its full Speed each time and was being outrun by a
 * Dashing rogue. One number tells those two apart, and nothing else does.
 */
function amend(text: string, plan: TurnPlan, performed: Performed): string {
  if (plan.stand && !performed.stood) {
    text = text.replace(`${plan.board.self.name} stands, then `, `${plan.board.self.name} `);
  }
  // A close that never reached is not an attack. Leaving "closes 33 ft and attacks with Bite"
  // on the card after a failed walk is how two Dire Wolves looked like they had a 40-foot reach.
  if (plan.chosen.kind === "close" && !performed.used) {
    const me = plan.board.self.name;
    const target = plan.chosen.target?.name ?? "its quarry";
    const units = plan.board.units;
    const prefix = performed.stood ? `${me} stands, then ` : `${me} `;
    return performed.moved > 0
      ? `${prefix}closes ${Math.round(performed.moved)} ${units} on ${target}, still too far to strike.`
      : `${prefix}tries to close on ${target}, and covers no ground at all.`;
  }

  if (!TRAVEL_ONLY.has(plan.chosen.kind)) return text;
  const moved = performed.moved;
  // Appended rather than spliced in. The sentences these plans produce differ in shape, and a regex
  // that has to find the right clause in each of them is one more thing to get wrong when a phrasing
  // changes; a trailing clause reads correctly whatever precedes it.
  const stem = text.replace(/\.\s*$/, "");
  return moved > 0
    ? `${stem}, covering ${Math.round(moved)} ${plan.board.units}.`
    : `${stem}, and covers no ground at all.`;
}

/** GM-only footnote: the tier that produced this and why the option scored well. */
function describeReasoning(plan: TurnPlan): string {
  const mental = plan.mental === null ? "unknown" : plan.mental.toFixed(1);
  const why =
    plan.chosen.reasons.length > 0 ? plan.chosen.reasons.join("; ") : "nothing else to do";
  const standing = plan.stand ? " Standing from Prone first." : "";
  const caveat =
    plan.profile.tier > TIER_CAVEAT
      ? " (tiers above genius have no mechanical behaviors yet — see AGENTS.md)"
      : "";
  return `Tier ${plan.profile.tier}, ${plan.profile.descriptor} — (INT+WIS)/2 = ${mental}. Chose: ${why}.${standing}${caveat}`;
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
    // Same predicate `takeTurn` uses. The console entry point reaches here without that gate, and
    // a second opinion that walked a paralyzed creature is how Hold Person looked broken after the
    // status had already landed.
    // A creature already running keeps running even if a status would otherwise skip the turn.
    // Skipping them here would leave the token on the scene forever and start a new fight later.
    if (isFleeingCombatant(combatant)) {
      await continueFlee(combatant);
      return;
    }

    if (isUnableToAct(combatant)) {
      log(`automation skipping ${combatant?.name ?? "?"}: ${skipReason(combatant)}`);
      return;
    }

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
      banter: heckledActor
        ? banterProfile(combatant?.actor, heckledActor, String(combatant?.id ?? ""))
        : null,
    });
    log(`${intent} [${reasoning}]`);

    // The intent is public — it is what the table watches happen. The reasoning stays in the console
    // and out of the chat log: players seeing "tier 3, looks like the easy one" would be told exactly
    // how the monster thinks, which is the GM's information, not theirs.
    const ChatMessage = (globalThis as any).ChatMessage;
    const card = await ChatMessage.create({
      content: `<p>${foundry.utils.escapeHTML(intent)}</p>`,
      speaker: speakerFor(combatant?.token ?? combatant?.actor, plan.board.self.name),
    });

    // Now make it happen: move the token, nominate the target, and hand the roll to the system so the
    // table's automation resolves it. Announced first so the narration reads ahead of the dice cards.
    const performed = await performPlan(plan);

    // The card is amended rather than followed by a second one. Announcing first is deliberate (the
    // narration has to read ahead of the dice), but for a movement-only plan the distance is not known
    // until afterwards — and a separate "it moved 30 ft" line would double the log for every advance.
    // A failed edit is a card that is merely vague, so it is logged and nothing else.
    const settled = amend(intent, plan, performed);
    if (settled !== intent) {
      await card
        ?.update?.({ content: `<p>${foundry.utils.escapeHTML(settled)}</p>` })
        .catch((err: unknown) => log("could not amend the turn announcement:", err));
    }
    if (performed.problem) {
      log(`execution problem for ${plan.board.self.name}: ${performed.problem}`);
      await ChatMessage.create({
        content: `<p><em>${foundry.utils.escapeHTML(plan.board.self.name)}: Noodlr could not carry that out (${foundry.utils.escapeHTML(performed.problem)}). Resolve it manually.</em></p>`,
        speaker: narrator(),
        whisper: ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
      });
    }

    noteDossierEvent(String(combatant.id ?? ""), `Round ${game.combat?.round ?? "?"}: ${settled}`);

    // Three of the outcomes take a creature out of the fight for good, on terms the addendum
    // spells out. Recording them is what lets an encounter end without a body count.
    if (plan.chosen.kind === "flee") {
      await beginFlee(combatant);
    } else {
      const outcome = OUTCOMES[plan.chosen.kind];
      if (outcome) await resolveCombatant(combatant, outcome);
    }
  } catch (err) {
    log("NPC turn planning failed:", err);
    ui.notifications?.error(game.i18n.format("NOODLRHOOKS.Combat.Failed", { error: String(err) }));
  }
}
