// Combat feature settings: the AI-run-NPC-turn system prompt.

import { MODULE_ID, COMBAT_SETTINGS } from "../constants";
import { promptDefault, promptValue } from "../prompts/fields";

/**
 * How much of a hostile creature's turn Noodlr runs:
 *   full    — every non-player combatant is played automatically when its turn comes up.
 *   partial — only the creatures the GM opted in with the "Act as NPC" tool, for this fight only.
 *   off     — nothing is automated and the tool is not offered.
 */
export type CombatAutomationMode = "full" | "partial" | "off";

export function registerCombatSettings(): void {
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.systemPrompt, {
    scope: "world",
    config: false,
    type: String,
    default: promptDefault(COMBAT_SETTINGS.systemPrompt),
  });
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.automation, {
    scope: "world",
    config: false,
    type: String,
    default: "full",
  });
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.banter, {
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
  });
}

export function getCombatAutomation(): CombatAutomationMode {
  const raw = String(game.settings.get(MODULE_ID, COMBAT_SETTINGS.automation) ?? "full");
  return raw === "partial" || raw === "off" ? raw : "full";
}

export function isNpcBanterEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.banter));
}

/** The combat system prompt as stored — ships pre-filled, read verbatim (see prompts/fields.ts). */
export function getCombatSystemPrompt(): string {
  return promptValue(game.settings.get(MODULE_ID, COMBAT_SETTINGS.systemPrompt));
}
