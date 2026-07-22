// AI-run NPC/monster turns. The model DECIDES and NARRATES a non-player combatant's
// action; mechanical resolution is left to real dice ({{roll:...}}) and the table's
// automation modules (Midi QoL, DAE, ...). Output is posted to Foundry chat under the
// combatant's name so the whole table sees it.

import { log } from "../constants";
import { getFeatureConfig } from "../providers/config";
import { isConfigured } from "../providers/types";
import { streamChatCompletion } from "../providers/chat-client";
import { resolveRollMacros } from "../dice/roll-macros";
import { renderMarkdown } from "../util/markdown";
import { buildCombatStateBlock } from "./tracker";
import { getCombatSystemPrompt } from "./config";

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

  const state = buildCombatStateBlock() ?? "";
  const messages = [
    { role: "system" as const, content: getCombatSystemPrompt() },
    { role: "system" as const, content: state },
    {
      role: "user" as const,
      content: `It is ${combatant.name}'s turn. Decide and narrate their single action now. Use {{roll:...}} for any dice.`,
    },
  ];

  ui.notifications?.info(game.i18n.format("NOODLR.Combat.Running", { name: combatant.name }));
  try {
    let raw = "";
    for await (const delta of streamChatCompletion(cfg, { messages })) raw += delta;
    const { text } = await resolveRollMacros(raw);

    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content: renderMarkdown(text),
      speaker: { alias: combatant.name },
    });
  } catch (err) {
    log("NPC turn failed:", err);
    ui.notifications?.error(game.i18n.format("NOODLR.Combat.Failed", { error: String(err) }));
  }
}
