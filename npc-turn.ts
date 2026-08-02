// AI-run NPC/monster turns. The model DECIDES and NARRATES a non-player combatant's actions;
// mechanical resolution is left to real dice ({{roll:...}}) and the table's automation modules
// (Midi QoL, DAE, ...). Output is posted to Foundry chat under the combatant's name.
//
// A turn is a LOOP, not a message (N2, 2026-08-02). The old single completion asked for "their single
// action", which made multiattack, bonus actions, and move-then-shoot structurally impossible: the
// model wrote one beat and the turn was over. Worse, dice macros resolve AFTER generation, so the
// creature never saw a result before committing to everything else it said. Each pass now narrates
// one beat, Foundry rolls its dice for real, the authoritative totals go back in, and the creature
// decides what to do with the rest of its turn — until it writes END TURN or the step cap trips.
//
// The whole turn is posted as ONE chat message and spoken once. Per-step cards would flood the log,
// and per-step TTS would overlap itself (a bug we already fixed once elsewhere).

import { log } from "../constants";
import { getFeatureConfig } from "../providers/config";
import { isConfigured } from "../providers/types";
import { streamChatCompletion } from "../providers/chat-client";
import { formatRollResultsForModel, resolveRollMacros } from "../dice/roll-macros";
import { renderMarkdown } from "../util/markdown";
import { buildCombatStateBlock } from "./tracker";
import { buildDossierBlock, noteDossierEvent } from "./dossier";
import { getCombatSystemPrompt } from "./config";
import { getTtsEnabled } from "../media/config";
import { speakForActor } from "../media/creature-voice";
import { buildRulesetBlock } from "../system/ruleset";
import type { ChatMessage as ProviderMessage } from "../providers/types";

/**
 * Beats one creature may take in a single turn. Four covers the common worst case (move, attack,
 * attack again, bonus action) without letting a confused model bill you for a dozen requests. A
 * creature that needs more is a sign the loop needs the structured-intent gate (N3), not a bigger cap.
 */
const MAX_TURN_STEPS = 4;

/** Sentinel the model writes when the creature is done. Stripped before anything is posted. */
const END_TURN = /\bEND\s+TURN\b/i;

function turnInstructions(name: string): string {
  return (
    `It is ${name}'s turn. Narrate ONE beat of it now — a single move, attack, spell, or item use ` +
    `— and stop there. Use {{roll:...}} for every die; Foundry rolls them for real and will show ` +
    `you the results before you continue, so never state an outcome you have not been given. ` +
    `Spend only what the dossier says ${name} still has. When the turn is genuinely over, write ` +
    `END TURN on its own line.`
  );
}

/** Run the current combatant's turn if it is a non-player creature. */
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
  const isPC = Boolean(combatant.hasPlayerOwner ?? combatant.actor?.hasPlayerOwner);
  if (isPC) {
    ui.notifications?.warn(game.i18n.localize("NOODLR.Combat.IsPC"));
    return;
  }

  const cfg = getFeatureConfig("chat");
  if (!isConfigured(cfg)) {
    ui.notifications?.error(game.i18n.localize("NOODLR.Combat.NotConfigured"));
    return;
  }

  // Empty blocks are dropped rather than sent as empty system messages (some providers reject those):
  // the combat prompt can be cleared by the GM, and there is no state block outside combat.
  const combatPrompt = getCombatSystemPrompt();
  const state = buildCombatStateBlock() ?? "";
  // What this creature actually is. Without it the model improvises a statblock from the name.
  const dossier = buildDossierBlock(combatant) ?? "";

  const messages: ProviderMessage[] = [
    ...(combatPrompt ? [{ role: "system" as const, content: combatPrompt }] : []),
    { role: "system" as const, content: buildRulesetBlock() },
    ...(state ? [{ role: "system" as const, content: state }] : []),
    ...(dossier ? [{ role: "system" as const, content: dossier }] : []),
    { role: "user" as const, content: turnInstructions(combatant.name) },
  ];

  ui.notifications?.info(game.i18n.format("NOODLR.Combat.Running", { name: combatant.name }));
  const beats: string[] = [];

  try {
    for (let step = 0; step < MAX_TURN_STEPS; step++) {
      let raw = "";
      for await (const delta of streamChatCompletion(cfg, { messages })) raw += delta;

      const finished = END_TURN.test(raw);
      const { text, rolls } = await resolveRollMacros(raw.replace(END_TURN, "").trim());
      if (text) {
        beats.push(text);
        messages.push({ role: "assistant", content: text });
      }
      if (finished) break;

      // Nothing said and nothing rolled means the model has run dry; stop rather than pay for a
      // second helping of silence.
      if (!text && rolls.length === 0) break;

      const results =
        rolls.length > 0
          ? `${formatRollResultsForModel(rolls)}\n\n`
          : "No dice were rolled for that beat.\n\n";
      messages.push({
        role: "user",
        content:
          `${results}Continue ${combatant.name}'s turn from these results if it still has actions ` +
          `or movement left, or write END TURN if it is finished. Do not repeat what you already narrated.`,
      });
    }

    await postTurn(combat, combatant, beats);
  } catch (err) {
    log("NPC turn failed:", err);
    ui.notifications?.error(game.i18n.format("NOODLR.Combat.Failed", { error: String(err) }));
    // Salvage: a provider hiccup on beat three shouldn't discard the two beats before it. Those
    // dice were really rolled, and the table is entitled to see what they were.
    if (beats.length > 0) {
      try {
        await postTurn(combat, combatant, beats);
      } catch (postErr) {
        log("could not post the partial NPC turn:", postErr);
      }
    }
  }
}

/** Post the accumulated beats as one message, remember them, and speak them once. */
async function postTurn(combat: any, combatant: any, beats: string[]): Promise<void> {
  const full = beats.join("\n\n").trim();
  if (!full) {
    ui.notifications?.warn(game.i18n.format("NOODLR.Combat.Empty", { name: combatant.name }));
    return;
  }

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content: renderMarkdown(full),
    speaker: { alias: combatant.name },
  });

  // Give the creature something to remember on its next turn: a bloodied archer that closed to
  // melee last round should not wander back out again as if the fight just started.
  noteDossierEvent(
    String(combatant.id ?? ""),
    `Round ${combat?.round ?? "?"}: ${full.slice(0, 200)}`,
  );

  // Voice the narration using the combatant's creature-type voice/pitch, if TTS is on.
  if (getTtsEnabled() && combatant.actor) void speakForActor(full, combatant.actor);
}
