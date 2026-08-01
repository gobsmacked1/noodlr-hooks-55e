// Combat feature settings: the AI-run-NPC-turn system prompt.

import { MODULE_ID, COMBAT_SETTINGS } from "../constants";
import { promptDefault, promptValue } from "../prompts/fields";

export function registerCombatSettings(): void {
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.systemPrompt, {
    scope: "world",
    config: false,
    type: String,
    default: promptDefault(COMBAT_SETTINGS.systemPrompt),
  });
}

/** The combat system prompt as stored — ships pre-filled, read verbatim (see prompts/fields.ts). */
export function getCombatSystemPrompt(): string {
  return promptValue(game.settings.get(MODULE_ID, COMBAT_SETTINGS.systemPrompt));
}
