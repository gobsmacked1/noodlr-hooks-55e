// Combat feature settings: the AI-run-NPC-turn system prompt override.

import { MODULE_ID, COMBAT_SETTINGS, DEFAULT_COMBAT_PROMPT } from "../constants";

export function registerCombatSettings(): void {
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.systemPrompt, {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });
}

/** Effective combat system prompt: override if set, else the built-in default. */
export function getCombatSystemPrompt(): string {
  const override = (game.settings.get(MODULE_ID, COMBAT_SETTINGS.systemPrompt) as string) ?? "";
  return override.trim().length > 0 ? override : DEFAULT_COMBAT_PROMPT;
}
